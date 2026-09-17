import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID, createHash } from 'crypto';
import { IngestionRun } from './ingestion-run.entity';
import { DeadLetterRecord } from './dead-letter-record.entity';
import { IngestionContentHash } from './ingestion-content-hash.entity';
import { CreateIngestionRunDto } from './dto/create-ingestion-run.dto';
import { IngestionRunStatus } from './enums/ingestion-run-status.enum';
import { IngestionConfig, IngestionMetrics } from './ingestion.types';
import { ProjectsService } from '../projects/projects.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { ChunkingService } from '../chunking/chunking.service';
import { EmbeddingClientService } from '../embedding-client/embedding-client.service';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { mapWithConcurrency, RateLimiter } from '../common/concurrency-limiter';
import { retryWithBackoff } from '../common/retry';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { VectorRecord } from '../database-adapters/vector-database-adapter.interface';

interface PendingDeadLetter {
  documentId?: string;
  chunkIndex?: number;
  reason: string;
  payloadSnapshot: Record<string, unknown>;
}

interface PreparedRecord {
  record: VectorRecord;
  contentHash: string;
  text: string;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @InjectRepository(IngestionRun) private readonly runs: Repository<IngestionRun>,
    @InjectRepository(DeadLetterRecord) private readonly deadLetters: Repository<DeadLetterRecord>,
    @InjectRepository(IngestionContentHash) private readonly contentHashes: Repository<IngestionContentHash>,
    private readonly projectsService: ProjectsService,
    private readonly dataPipelineDesignService: DataPipelineDesignService,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingClient: EmbeddingClientService,
    private readonly adapterFactory: VectorAdapterFactory,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  async runIngestion(projectId: string, requester: AuthenticatedUser, dto: CreateIngestionRunDto): Promise<IngestionRun> {
    const startedAt = Date.now();
    const project = await this.projectsService.findOne(projectId, requester);
    const pipelineDesign = await this.dataPipelineDesignService.getLatest(projectId, requester);
    if (!pipelineDesign) {
      throw new BadRequestException('Complete Phase 2 (Data & Embedding Design) before running ingestion.');
    }

    const config = this.resolveConfig(dto);
    const adapter = this.adapterFactory.getAdapter(project.platform);
    const rateLimiter = new RateLimiter(config.rateLimitPerSecond);

    const metrics: IngestionMetrics = {
      documentsSubmitted: dto.documents.length,
      documentsCorrupted: 0,
      chunksProduced: 0,
      chunksEmbedded: 0,
      chunksDeduplicated: 0,
      chunksStored: 0,
      chunksDeadLettered: 0,
      durationMs: 0,
    };
    const pendingDeadLetters: PendingDeadLetter[] = [];

    // --- Extract/Clean/Chunk ---
    const allowedMetadataFields = new Set(pipelineDesign.metadataFields.map((f) => f.name));
    const pendingChunks: Array<{ docId: string; chunkIndex: number; text: string; metadata: Record<string, unknown> }> = [];
    for (const document of dto.documents) {
      // Validate stage: catch a metadata/schema mismatch here, before spending an
      // embedding call on it - upsert would otherwise fail with a raw driver error
      // (e.g. "column ... does not exist") that's meaningless to the caller.
      const unknownFields = Object.keys(document.metadata).filter((k) => !allowedMetadataFields.has(k));
      if (unknownFields.length > 0) {
        metrics.documentsCorrupted++;
        pendingDeadLetters.push({
          documentId: document.id,
          reason:
            `Metadata field(s) '${unknownFields.join("', '")}' are not part of this project's Phase 2 schema ` +
            `(declared fields: ${[...allowedMetadataFields].join(', ') || 'none'}). Update the Data Pipeline Design ` +
            'or fix the document metadata to match, then retry.',
          payloadSnapshot: { metadata: document.metadata },
        });
        continue;
      }
      const cleanedText = document.text.trim().replace(/\s+/g, ' ');
      if (!cleanedText) {
        metrics.documentsCorrupted++;
        pendingDeadLetters.push({
          documentId: document.id,
          reason: 'Document text is empty after cleaning (corrupted or empty document).',
          payloadSnapshot: { metadata: document.metadata },
        });
        continue;
      }
      const docId = document.id ?? randomUUID();
      const chunkResult = this.chunkingService.chunk(cleanedText, {
        strategy: pipelineDesign.chunkingStrategy,
        chunkSize: pipelineDesign.chunkSize,
        chunkOverlap: pipelineDesign.chunkOverlap,
        minChunkSize: pipelineDesign.minChunkSize,
        maxChunkSize: pipelineDesign.maxChunkSize,
      });
      metrics.chunksProduced += chunkResult.chunks.length;
      for (const chunk of chunkResult.chunks) {
        pendingChunks.push({ docId, chunkIndex: chunk.index, text: chunk.text, metadata: document.metadata });
      }
    }

    // --- Deduplicate/Embed/Validate (bounded concurrency + rate limit) ---
    const prepared = await mapWithConcurrency(pendingChunks, config.embeddingConcurrency, async (chunk) => {
      const contentHash = createHash('sha256').update(chunk.text).digest('hex');
      const alreadyStored = await this.contentHashes.findOne({
        where: { project: { id: projectId }, collectionName: pipelineDesign.collectionName, contentHash },
      });
      if (alreadyStored) {
        metrics.chunksDeduplicated++;
        return null;
      }

      await rateLimiter.acquire();
      const recordId = `${chunk.docId}::${chunk.chunkIndex}`;
      try {
        const embedding = await retryWithBackoff(
          () =>
            this.embeddingClient.embed({
              providerId: pipelineDesign.embeddingProviderId,
              modelId: pipelineDesign.embeddingModelId,
              dimension: pipelineDesign.embeddingDimension,
              text: chunk.text,
            }),
          config.retryCount,
          config.retryBackoffMs,
        );
        metrics.chunksEmbedded++;

        if (embedding.vector.length !== pipelineDesign.embeddingDimension || embedding.vector.some((v) => !Number.isFinite(v))) {
          metrics.chunksDeadLettered++;
          pendingDeadLetters.push({
            documentId: chunk.docId,
            chunkIndex: chunk.chunkIndex,
            reason: `Invalid embedding vector: expected ${pipelineDesign.embeddingDimension} finite dimensions, got ${embedding.vector.length}.`,
            payloadSnapshot: { text: chunk.text.slice(0, 500) },
          });
          return null;
        }

        const prepared: PreparedRecord = {
          record: { id: recordId, vector: embedding.vector, metadata: chunk.metadata },
          contentHash,
          text: chunk.text,
        };
        return prepared;
      } catch (error) {
        metrics.chunksDeadLettered++;
        pendingDeadLetters.push({
          documentId: chunk.docId,
          chunkIndex: chunk.chunkIndex,
          reason: `Embedding failed after ${config.retryCount} retries: ${(error as Error).message}`,
          payloadSnapshot: { text: chunk.text.slice(0, 500) },
        });
        return null;
      }
    });

    const validRecords = prepared.filter((p): p is PreparedRecord => p !== null);

    // --- Batch/Insert ---
    for (let i = 0; i < validRecords.length; i += config.batchSize) {
      const batch = validRecords.slice(i, i + config.batchSize);
      try {
        await retryWithBackoff(
          () => adapter.upsert(pipelineDesign.collectionName, batch.map((b) => b.record)),
          config.retryCount,
          config.retryBackoffMs,
        );
        metrics.chunksStored += batch.length;
        for (const { record, contentHash } of batch) {
          await this.contentHashes
            .save(
              this.contentHashes.create({
                project: { id: projectId } as Project,
                collectionName: pipelineDesign.collectionName,
                contentHash,
                recordId: record.id,
              }),
            )
            .catch(() => undefined); // unique-constraint race with a concurrent run - the row already exists, which is fine.
        }
      } catch (error) {
        metrics.chunksDeadLettered += batch.length;
        for (const { record, text } of batch) {
          const [docId, chunkIndexRaw] = record.id.split('::');
          pendingDeadLetters.push({
            documentId: docId,
            chunkIndex: Number(chunkIndexRaw),
            reason: `Storage failed after ${config.retryCount} retries: ${(error as Error).message}`,
            payloadSnapshot: { text: text.slice(0, 500), metadata: record.metadata },
          });
        }
      }
    }

    metrics.durationMs = Date.now() - startedAt;
    const status =
      pendingDeadLetters.length === 0
        ? IngestionRunStatus.COMPLETED
        : metrics.chunksStored > 0
          ? IngestionRunStatus.COMPLETED_WITH_ERRORS
          : IngestionRunStatus.FAILED;

    const previousCount = await this.runs.count({ where: { project: { id: projectId } } });
    const run = await this.runs.save(
      this.runs.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version: previousCount + 1,
        status,
        collectionName: pipelineDesign.collectionName,
        configUsed: config,
        metrics,
      }),
    );

    if (pendingDeadLetters.length > 0) {
      await this.deadLetters.save(
        pendingDeadLetters.map((dl) =>
          this.deadLetters.create({ ingestionRun: { id: run.id } as IngestionRun, ...dl }),
        ),
      );
    }

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.INGESTION, PhaseStatus.COMPLETED);

    this.logger.log(
      `user=${requester.email} action=run_ingestion projectId=${projectId} runVersion=${run.version} status=${status} ` +
        `stored=${metrics.chunksStored} deadLettered=${metrics.chunksDeadLettered} deduplicated=${metrics.chunksDeduplicated}`,
    );

    return run;
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<IngestionRun[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.runs.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getRun(projectId: string, requester: AuthenticatedUser, runId: string): Promise<IngestionRun> {
    await this.projectsService.findOne(projectId, requester);
    const run = await this.runs.findOne({ where: { id: runId, project: { id: projectId } } });
    if (!run) {
      throw new BadRequestException(`Ingestion run '${runId}' was not found for this project.`);
    }
    return run;
  }

  async getDeadLetters(projectId: string, requester: AuthenticatedUser, runId: string): Promise<DeadLetterRecord[]> {
    await this.getRun(projectId, requester, runId);
    return this.deadLetters.find({ where: { ingestionRun: { id: runId } }, order: { createdAt: 'ASC' } });
  }

  /**
   * Failure recovery: re-embeds and re-stores every not-yet-reprocessed dead
   * letter that still has captured text (storage/embedding failures). Dead
   * letters from corrupted/empty documents have no text to retry and are
   * skipped. Marks each row `reprocessed` on success; leaves it for another
   * retry attempt on repeat failure.
   */
  async retryDeadLetters(projectId: string, requester: AuthenticatedUser, runId: string): Promise<{ reprocessed: number; stillFailed: number }> {
    const project = await this.projectsService.findOne(projectId, requester);
    const run = await this.getRun(projectId, requester, runId);
    const pipelineDesign = await this.dataPipelineDesignService.getLatest(projectId, requester);
    if (!pipelineDesign) {
      throw new BadRequestException('Complete Phase 2 (Data & Embedding Design) before retrying dead letters.');
    }
    const adapter = this.adapterFactory.getAdapter(project.platform);
    const config = this.resolveConfig({ documents: [] } as unknown as CreateIngestionRunDto);

    const candidates = (await this.deadLetters.find({ where: { ingestionRun: { id: run.id }, reprocessed: false } })).filter(
      (dl) => typeof dl.payloadSnapshot.text === 'string',
    );

    let reprocessed = 0;
    let stillFailed = 0;

    for (const dl of candidates) {
      try {
        const text = dl.payloadSnapshot.text as string;
        const embedding = await retryWithBackoff(
          () =>
            this.embeddingClient.embed({
              providerId: pipelineDesign.embeddingProviderId,
              modelId: pipelineDesign.embeddingModelId,
              dimension: pipelineDesign.embeddingDimension,
              text,
            }),
          config.retryCount,
          config.retryBackoffMs,
        );
        if (embedding.vector.length !== pipelineDesign.embeddingDimension) {
          throw new Error('Invalid embedding dimension on reprocess.');
        }
        const recordId = `${dl.documentId}::${dl.chunkIndex}`;
        const metadata = (dl.payloadSnapshot.metadata as Record<string, unknown>) ?? {};
        await retryWithBackoff(
          () => adapter.upsert(pipelineDesign.collectionName, [{ id: recordId, vector: embedding.vector, metadata }]),
          config.retryCount,
          config.retryBackoffMs,
        );
        dl.reprocessed = true;
        await this.deadLetters.save(dl);
        await this.contentHashes
          .save(
            this.contentHashes.create({
              project: { id: projectId } as Project,
              collectionName: pipelineDesign.collectionName,
              contentHash: createHash('sha256').update(text).digest('hex'),
              recordId,
            }),
          )
          .catch(() => undefined);
        reprocessed++;
      } catch (error) {
        this.logger.warn(`Reprocessing dead letter '${dl.id}' failed again: ${(error as Error).message}`);
        stillFailed++;
      }
    }

    return { reprocessed, stillFailed };
  }

  private resolveConfig(dto: CreateIngestionRunDto): IngestionConfig {
    const defaults = this.platformConfig.getPipelineDefaults();
    return {
      batchSize: dto.config?.batchSize ?? defaults.batchSize,
      embeddingConcurrency: dto.config?.embeddingConcurrency ?? defaults.embeddingConcurrency,
      retryCount: dto.config?.retryCount ?? defaults.retryCount,
      retryBackoffMs: dto.config?.retryBackoffMs ?? defaults.retryBackoffMs,
      rateLimitPerSecond: dto.config?.rateLimitPerSecond ?? defaults.rateLimitPerSecond,
    };
  }
}
