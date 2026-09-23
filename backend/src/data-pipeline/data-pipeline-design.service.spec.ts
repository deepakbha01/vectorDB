import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataPipelineDesignService } from './data-pipeline-design.service';
import { DataPipelineDesign } from './data-pipeline-design.entity';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { CreateDataPipelineDesignDto } from './dto/create-data-pipeline-design.dto';

describe('DataPipelineDesignService', () => {
  let service: DataPipelineDesignService;
  let designsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let embeddingsService: { resolveModel: jest.Mock };
  let schemaGenerator: { generateAll: jest.Mock };
  let platformConfig: { getPipelineDefaults: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };

  const dto: CreateDataPipelineDesignDto = {
    collectionName: 'support_docs',
    chunking: { strategy: ChunkingStrategy.SENTENCE_BASED, chunkSize: 500, chunkOverlap: 50 },
    embeddingProviderId: 'openai',
    embeddingModelId: 'text-embedding-3-small',
    metadataFields: [{ name: 'source', type: 'string' }],
  };

  const model = {
    id: 'text-embedding-3-small',
    providerId: 'openai',
    providerLabel: 'OpenAI',
    dimension: 1536,
    maxInputTokens: 8191,
    costPerMillionTokens: 0.02,
    languageSupport: ['en'],
    qualityTier: 'high',
    modelVersion: '3-small',
    status: 'active',
  };

  beforeEach(async () => {
    designsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'design-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    projectsService = { findOne: jest.fn().mockResolvedValue({ id: 'project-1' }), updatePhaseStatus: jest.fn().mockResolvedValue({}) };
    discoveryService = { getLatest: jest.fn().mockResolvedValue(null) };
    embeddingsService = { resolveModel: jest.fn().mockReturnValue(model) };
    schemaGenerator = { generateAll: jest.fn().mockReturnValue({ oracle: {}, postgres_pgvector: {}, milvus: {} }) };
    platformConfig = {
      getPipelineDefaults: jest.fn().mockReturnValue({ retryCount: 3, retryBackoffMs: 2000, deadLetterEnabled: true, batchSize: 100 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataPipelineDesignService,
        { provide: getRepositoryToken(DataPipelineDesign), useValue: designsRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: EmbeddingsService, useValue: embeddingsService },
        { provide: SchemaGeneratorService, useValue: schemaGenerator },
        { provide: PlatformConfigService, useValue: platformConfig },
      ],
    }).compile();

    service = module.get(DataPipelineDesignService);
  });

  it('resolves the embedding model, generates schemas, and persists version 1', async () => {
    const design = await service.submitDesign('project-1', requester, dto);

    expect(embeddingsService.resolveModel).toHaveBeenCalledWith('openai', 'text-embedding-3-small');
    expect(schemaGenerator.generateAll).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'support_docs', dimension: 1536 }),
    );
    expect(designsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ version: 1, embeddingDimension: 1536 }));
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
    expect(design.pipelineStages).toHaveLength(9);
    expect(design.pipelineStages.map((s: any) => s.name)).toContain('Deduplicate');
  });

  it('blocks submission with a structured, machine-readable error when the model dimension does not match Discovery, until acknowledged', async () => {
    discoveryService.getLatest.mockResolvedValue({ assessment: { embeddingDimension: 768, similarityMetric: 'cosine' } });

    await expect(service.submitDesign('project-1', requester, dto)).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'DIMENSION_MISMATCH_CONFIRMATION_REQUIRED' }),
    });

    const design: any = await service.submitDesign('project-1', requester, {
      ...dto,
      dimensionMismatchAcknowledged: true,
      dimensionMismatchReason: 'model_quality_requirement' as any,
    });
    expect(design.validationWarnings.some((w: string) => w.includes('confirmed intentional'))).toBe(true);
    expect(design.dimensionMismatchReason).toBe('model_quality_requirement');
  });

  it('warns when the configured chunk size may exceed the model max input tokens', async () => {
    embeddingsService.resolveModel.mockReturnValue({ ...model, maxInputTokens: 50 });
    const design: any = await service.submitDesign(
      'project-1',
      requester,
      { ...dto, chunking: { strategy: ChunkingStrategy.FIXED_SIZE, chunkSize: 5000, chunkOverlap: 0 } },
    );
    expect(design.validationWarnings.some((w: string) => w.includes('max input'))).toBe(true);
  });

  it('increments version on a second submission', async () => {
    designsRepo.count.mockResolvedValue(2);
    const design: any = await service.submitDesign('project-1', requester, dto);
    expect(design.version).toBe(3);
  });

  it('rejects duplicate metadata field names (case-insensitive) before generating any schema', async () => {
    const badDto = { ...dto, metadataFields: [{ name: 'source_url', type: 'string' as const }, { name: 'Source_URL', type: 'json' as const }] };
    await expect(service.submitDesign('project-1', requester, badDto)).rejects.toThrow(/Duplicate metadata field name/);
    expect(schemaGenerator.generateAll).not.toHaveBeenCalled();
  });

  it('rejects metadata field names that collide with the reserved id/embedding/created_at columns', async () => {
    const badDto = { ...dto, metadataFields: [{ name: 'embedding', type: 'string' as const }] };
    await expect(service.submitDesign('project-1', requester, badDto)).rejects.toThrow(/reserved columns/);
    expect(schemaGenerator.generateAll).not.toHaveBeenCalled();
  });
});
