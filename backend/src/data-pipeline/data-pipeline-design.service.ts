import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataPipelineDesign, PipelineStage } from './data-pipeline-design.entity';
import { CreateDataPipelineDesignDto } from './dto/create-data-pipeline-design.dto';
import { Phase2Handoff } from './data-pipeline-design.types';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryOutcome, DiscoveryService } from '../discovery/discovery.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { RESERVED_METADATA_FIELD_NAMES } from '../schema-generator/schema-generator.types';
import { SimilarityMetric } from '../discovery/enums/discovery.enum';
import { IndexType } from '../index-recommendation-engine/index-recommendation.types';
import { buildDataPipelineExecutiveSummary } from './plain-language-summary';

const PIPELINE_STAGES: PipelineStage[] = [
  { name: 'Source', description: 'Original documents/records land here (file store, CMS, database export, API feed).' },
  { name: 'Extract', description: 'Raw text and structured metadata are pulled out of source formats (PDF, HTML, DOCX, JSON, etc.).' },
  { name: 'Clean', description: 'Normalization: whitespace/encoding cleanup, boilerplate removal.' },
  { name: 'Deduplicate', description: 'Exact-duplicate chunks are detected by content hash and skipped (see IngestionService - this runs for real at Phase 5).' },
  { name: 'Chunk', description: 'Document text is split into chunks using the configured chunking strategy.' },
  { name: 'Embed', description: 'Each chunk is sent to the configured embedding provider/model to produce a vector.' },
  { name: 'Validate', description: 'Vector dimension, schema conformance, and required metadata fields are checked before storage.' },
  { name: 'Store', description: 'Validated (vector, metadata) records are written to the target database.' },
  { name: 'Index', description: 'The vector index (Phase 3 - Index Design) is built/updated over newly stored vectors.' },
];

@Injectable()
export class DataPipelineDesignService {
  private readonly logger = new Logger(DataPipelineDesignService.name);

  constructor(
    @InjectRepository(DataPipelineDesign) private readonly designs: Repository<DataPipelineDesign>,
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly schemaGenerator: SchemaGeneratorService,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  async submitDesign(projectId: string, requester: AuthenticatedUser, dto: CreateDataPipelineDesignDto): Promise<DataPipelineDesign> {
    await this.projectsService.findOne(projectId, requester);

    this.validateMetadataFields(dto.metadataFields);

    const model = this.embeddingsService.resolveModel(dto.embeddingProviderId, dto.embeddingModelId);
    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    const metric = discoveryOutcome?.assessment.similarityMetric ?? SimilarityMetric.COSINE;

    const dimensionMismatch = discoveryOutcome !== null && discoveryOutcome.assessment.embeddingDimension !== model.dimension;
    if (dimensionMismatch && !dto.dimensionMismatchAcknowledged) {
      throw new BadRequestException({
        message:
          `Selected model dimension (${model.dimension}) does not match the Discovery assessment's estimated ` +
          `embedding dimension (${discoveryOutcome!.assessment.embeddingDimension}). Confirm this is intentional and ` +
          'resubmit with dimensionMismatchAcknowledged=true and a dimensionMismatchReason.',
        errorCode: 'DIMENSION_MISMATCH_CONFIRMATION_REQUIRED',
        details: { discoveryDimension: discoveryOutcome!.assessment.embeddingDimension, selectedDimension: model.dimension },
      });
    }

    const generatedSchemas = this.schemaGenerator.generateAll({
      collectionName: dto.collectionName,
      dimension: model.dimension,
      metric,
      metadataFields: dto.metadataFields,
    });

    if (model.status === 'deprecated') {
      this.logger.warn(`user=${requester.email} action=submit_data_pipeline_design projectId=${projectId} deprecatedModel=${model.providerId}/${model.id}`);
    }

    const warnings = this.buildValidationWarnings(dto, model, dimensionMismatch, discoveryOutcome);

    const previousCount = await this.designs.count({ where: { project: { id: projectId } } });
    const version = previousCount + 1;
    const pipelineDefaults = this.platformConfig.getPipelineDefaults();

    const design = await this.designs.save(
      this.designs.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        collectionName: dto.collectionName,
        chunkingStrategy: dto.chunking.strategy,
        chunkSize: dto.chunking.chunkSize,
        chunkOverlap: dto.chunking.chunkOverlap,
        minChunkSize: dto.chunking.minChunkSize,
        maxChunkSize: dto.chunking.maxChunkSize,
        embeddingProviderId: model.providerId,
        embeddingModelId: model.id,
        embeddingDimension: model.dimension,
        similarityMetric: metric,
        dimensionMismatchReason: dimensionMismatch ? (dto.dimensionMismatchReason ?? null) : null,
        maxInputTokens: model.maxInputTokens,
        costPerMillionTokens: model.costPerMillionTokens,
        languageSupport: model.languageSupport,
        qualityTier: model.qualityTier,
        modelVersion: model.modelVersion,
        metadataFields: dto.metadataFields,
        generatedSchemas,
        pipelineStages: PIPELINE_STAGES,
        errorHandling: {
          retryCount: pipelineDefaults.retryCount,
          retryBackoffMs: pipelineDefaults.retryBackoffMs,
          deadLetterEnabled: pipelineDefaults.deadLetterEnabled,
          batchSize: pipelineDefaults.batchSize,
          monitoringMetrics: [
            'chunks_produced_total',
            'embedding_requests_total',
            'embedding_failures_total',
            'records_stored_total',
            'records_dead_lettered_total',
            'pipeline_stage_duration_ms',
          ],
        },
        validationWarnings: warnings,
        executiveSummary: buildDataPipelineExecutiveSummary({
          chunkingStrategy: dto.chunking.strategy,
          chunkSize: dto.chunking.chunkSize,
          chunkOverlap: dto.chunking.chunkOverlap,
          embeddingProviderId: model.providerId,
          embeddingModelId: model.id,
          embeddingDimension: model.dimension,
          costPerMillionTokens: model.costPerMillionTokens,
          qualityTier: model.qualityTier,
          metadataFieldCount: dto.metadataFields.length,
          validationWarnings: warnings,
        }),
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.DATA_EMBEDDINGS, PhaseStatus.COMPLETED);

    this.logger.log(
      `user=${requester.email} action=submit_data_pipeline_design projectId=${projectId} version=${version} model=${model.providerId}/${model.id}`,
    );

    return design;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<DataPipelineDesign | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<DataPipelineDesign[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /**
   * The formal Phase 2 -> Phase 3 handoff (spec S9/S10). IndexDesignService
   * consumes this instead of reading Discovery/Data Pipeline Design fields
   * ad hoc - status is BLOCKED (with reasons) rather than silently falling
   * back to partial data when a prerequisite phase is incomplete.
   */
  async buildPhase3Handoff(projectId: string, requester: AuthenticatedUser): Promise<Phase2Handoff> {
    await this.projectsService.findOne(projectId, requester);

    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    const pipelineDesign = await this.getLatest(projectId, requester);

    const statusReasons: string[] = [];
    if (!discoveryOutcome) statusReasons.push('Phase 1 (Discovery) has not been completed.');
    if (!pipelineDesign) statusReasons.push('Phase 2 (Data & Embedding Design) has not been completed.');

    if (!discoveryOutcome || !pipelineDesign) {
      return {
        vectorCount: discoveryOutcome?.assessment.estimatedVectorCount ?? 0,
        dimension: pipelineDesign?.embeddingDimension ?? discoveryOutcome?.assessment.embeddingDimension ?? 0,
        metric: pipelineDesign?.similarityMetric ?? discoveryOutcome?.assessment.similarityMetric ?? SimilarityMetric.COSINE,
        availableMemoryGb: discoveryOutcome?.assessment.availableRamGb ?? 0,
        qps: discoveryOutcome?.assessment.qps ?? 0,
        peakQps: discoveryOutcome?.assessment.peakQps ?? 0,
        recallTarget: discoveryOutcome?.assessment.recallTarget ?? 0,
        targetP95LatencyMs: discoveryOutcome?.assessment.targetP95LatencyMs ?? 0,
        topK: discoveryOutcome?.assessment.topK ?? 0,
        candidateK: Math.max((discoveryOutcome?.assessment.topK ?? 0) * 10, 100),
        filterUsage: false,
        hybridSearch: discoveryOutcome?.assessment.requiresHybridSearch ?? false,
        reranking: discoveryOutcome?.assessment.requiresReranking ?? false,
        candidateIndexFamilies: Object.values(IndexType),
        status: 'BLOCKED',
        statusReasons,
      };
    }

    const { assessment } = discoveryOutcome;
    if (pipelineDesign.validationWarnings.length > 0) {
      statusReasons.push(...pipelineDesign.validationWarnings);
    }

    return {
      vectorCount: assessment.estimatedVectorCount,
      dimension: pipelineDesign.embeddingDimension,
      metric: pipelineDesign.similarityMetric,
      availableMemoryGb: assessment.availableRamGb,
      qps: assessment.qps,
      peakQps: assessment.peakQps,
      recallTarget: assessment.recallTarget,
      targetP95LatencyMs: assessment.targetP95LatencyMs,
      topK: assessment.topK,
      candidateK: Math.max(assessment.topK * 10, 100),
      filterUsage: pipelineDesign.metadataFields.some((f) => f.filterable !== false),
      hybridSearch: assessment.requiresHybridSearch,
      reranking: assessment.requiresReranking,
      candidateIndexFamilies: Object.values(IndexType),
      status: statusReasons.length > 0 ? 'READY_WITH_CONDITIONS' : 'READY',
      statusReasons,
    };
  }

  /** Case-insensitive duplicate names and collisions with the fixed id/embedding/created_at columns both block the design - every generated schema would otherwise be invalid. */
  private validateMetadataFields(fields: CreateDataPipelineDesignDto['metadataFields']): void {
    const seen = new Map<string, string>();
    const duplicates = new Set<string>();
    const reserved = new Set<string>();

    for (const field of fields) {
      const key = field.name.toLowerCase();
      if (seen.has(key)) {
        duplicates.add(seen.get(key)!);
        duplicates.add(field.name);
      }
      seen.set(key, field.name);
      if ((RESERVED_METADATA_FIELD_NAMES as readonly string[]).includes(key)) {
        reserved.add(field.name);
      }
    }

    const problems: string[] = [];
    if (duplicates.size > 0) {
      problems.push(`Duplicate metadata field name(s): ${[...duplicates].join(', ')}. Each field name must be unique.`);
    }
    if (reserved.size > 0) {
      problems.push(
        `Metadata field name(s) collide with reserved columns (${RESERVED_METADATA_FIELD_NAMES.join(', ')}): ${[...reserved].join(', ')}.`,
      );
    }
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }
  }

  private buildValidationWarnings(
    dto: CreateDataPipelineDesignDto,
    model: { dimension: number; maxInputTokens: number; status: string },
    dimensionMismatch: boolean,
    discoveryOutcome: DiscoveryOutcome | null,
  ): string[] {
    const warnings: string[] = [];

    if (dimensionMismatch && discoveryOutcome) {
      warnings.push(
        `Model dimension (${model.dimension}) differs from the Discovery assessment's estimated embedding dimension ` +
          `(${discoveryOutcome.assessment.embeddingDimension}) - confirmed intentional` +
          (dto.dimensionMismatchReason ? ` (reason: ${dto.dimensionMismatchReason}).` : '.'),
      );
    }

    if (model.status === 'deprecated') {
      warnings.push(`Embedding model '${dto.embeddingModelId}' is deprecated - consider migrating to an active model in the catalog.`);
    }

    const maxChunkSize = dto.chunking.maxChunkSize ?? dto.chunking.chunkSize;
    const isWordBased = dto.chunking.strategy === ChunkingStrategy.TOKEN_BASED;
    const approxTokens = isWordBased ? Math.ceil(maxChunkSize * 1.3) : Math.ceil(maxChunkSize / 4);
    if (approxTokens > model.maxInputTokens) {
      warnings.push(
        `The configured chunk size (~${approxTokens} estimated tokens) may exceed '${dto.embeddingModelId}'s max ` +
          `input of ${model.maxInputTokens} tokens; the provider may truncate longer chunks.`,
      );
    }

    return warnings;
  }
}
