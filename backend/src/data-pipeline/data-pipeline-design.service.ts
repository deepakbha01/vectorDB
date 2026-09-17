import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataPipelineDesign, PipelineStage } from './data-pipeline-design.entity';
import { CreateDataPipelineDesignDto } from './dto/create-data-pipeline-design.dto';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { buildDataPipelineExecutiveSummary } from './plain-language-summary';

const PIPELINE_STAGES: PipelineStage[] = [
  { name: 'Source', description: 'Original documents/records land here (file store, CMS, database export, API feed).' },
  { name: 'Extract', description: 'Raw text and structured metadata are pulled out of source formats (PDF, HTML, DOCX, JSON, etc.).' },
  { name: 'Clean', description: 'Normalization: whitespace/encoding cleanup, boilerplate removal, deduplication.' },
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

    const model = this.embeddingsService.resolveModel(dto.embeddingProviderId, dto.embeddingModelId);
    const generatedSchemas = this.schemaGenerator.generateAll({
      collectionName: dto.collectionName,
      dimension: model.dimension,
      metadataFields: dto.metadataFields,
    });

    const warnings = await this.buildValidationWarnings(projectId, requester, dto, model);

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

  private async buildValidationWarnings(
    projectId: string,
    requester: AuthenticatedUser,
    dto: CreateDataPipelineDesignDto,
    model: { dimension: number; maxInputTokens: number },
  ): Promise<string[]> {
    const warnings: string[] = [];

    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    if (discoveryOutcome && discoveryOutcome.assessment.embeddingDimension !== model.dimension) {
      warnings.push(
        `Selected model dimension (${model.dimension}) does not match the Discovery assessment's estimated ` +
          `embedding dimension (${discoveryOutcome.assessment.embeddingDimension}). Confirm this is intentional - ` +
          'the generated schema will use the selected model\'s dimension.',
      );
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
