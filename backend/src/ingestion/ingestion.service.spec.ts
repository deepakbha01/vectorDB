import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IngestionService } from './ingestion.service';
import { IngestionRun } from './ingestion-run.entity';
import { DeadLetterRecord } from './dead-letter-record.entity';
import { IngestionContentHash } from './ingestion-content-hash.entity';
import { ProjectsService } from '../projects/projects.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { ChunkingService } from '../chunking/chunking.service';
import { EmbeddingClientService } from '../embedding-client/embedding-client.service';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { IngestionRunStatus } from './enums/ingestion-run-status.enum';

describe('IngestionService', () => {
  let service: IngestionService;
  let runsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; find: jest.Mock; findOne: jest.Mock };
  let deadLettersRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let contentHashesRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let dataPipelineDesignService: { getLatest: jest.Mock };
  let chunkingServiceMock: { chunk: jest.Mock };
  let embeddingClient: { embed: jest.Mock };
  let adapterFactory: { getAdapter: jest.Mock };
  let platformConfig: { getPipelineDefaults: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };
  const pipelineDesign = {
    collectionName: 'docs',
    chunkingStrategy: ChunkingStrategy.FIXED_SIZE,
    chunkSize: 100,
    chunkOverlap: 0,
    embeddingProviderId: 'openai',
    embeddingModelId: 'text-embedding-3-small',
    embeddingDimension: 4,
    metadataFields: [{ name: 'source', type: 'string' }, { name: 'a', type: 'number' }],
  };

  function makeChunks(count: number) {
    return {
      chunks: Array.from({ length: count }, (_, i) => ({ index: i, text: `chunk ${i}`, charStart: 0, charEnd: 5, approxTokenCount: 2 })),
      stats: { count, avgSizeChars: 5, minSizeChars: 5, maxSizeChars: 5 },
      notes: [],
    };
  }

  beforeEach(async () => {
    runsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'run-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    deadLettersRepo = { create: jest.fn((data) => data), save: jest.fn((data) => Promise.resolve(data)), find: jest.fn() };
    contentHashesRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve(data)),
      findOne: jest.fn().mockResolvedValue(null),
    };
    projectsService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1', platform: VectorPlatform.POSTGRES_PGVECTOR }),
      updatePhaseStatus: jest.fn().mockResolvedValue({}),
    };
    dataPipelineDesignService = { getLatest: jest.fn().mockResolvedValue(pipelineDesign) };
    chunkingServiceMock = { chunk: jest.fn().mockReturnValue(makeChunks(1)) };
    embeddingClient = { embed: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3, 0.4], isLiveProvider: false }) };
    adapterFactory = { getAdapter: jest.fn() };
    platformConfig = {
      getPipelineDefaults: jest.fn().mockReturnValue({
        batchSize: 100,
        embeddingConcurrency: 5,
        retryCount: 2,
        retryBackoffMs: 1,
        rateLimitPerSecond: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: getRepositoryToken(IngestionRun), useValue: runsRepo },
        { provide: getRepositoryToken(DeadLetterRecord), useValue: deadLettersRepo },
        { provide: getRepositoryToken(IngestionContentHash), useValue: contentHashesRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DataPipelineDesignService, useValue: dataPipelineDesignService },
        { provide: ChunkingService, useValue: chunkingServiceMock },
        { provide: EmbeddingClientService, useValue: embeddingClient },
        { provide: VectorAdapterFactory, useValue: adapterFactory },
        { provide: PlatformConfigService, useValue: platformConfig },
      ],
    }).compile();

    service = module.get(IngestionService);
  });

  it('rejects ingestion before Phase 2 (Data Pipeline Design) is complete', async () => {
    dataPipelineDesignService.getLatest.mockResolvedValue(null);
    await expect(
      service.runIngestion('project-1', requester, { documents: [{ text: 'hello', metadata: {} }] } as any),
    ).rejects.toThrow(/Phase 2/);
  });

  it('stores chunks and reports a COMPLETED run when everything succeeds', async () => {
    const adapter = { upsert: jest.fn().mockResolvedValue(undefined) };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: { source: 'a' } }],
    } as any);

    expect(adapter.upsert).toHaveBeenCalledWith('docs', [
      expect.objectContaining({ id: 'doc-1::0', vector: [0.1, 0.2, 0.3, 0.4], metadata: { source: 'a' } }),
    ]);
    expect(run.status).toBe(IngestionRunStatus.COMPLETED);
    expect(run.metrics.chunksStored).toBe(1);
    expect(run.metrics.chunksDeadLettered).toBe(0);
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
  });

  it('dead-letters a document that is empty after cleaning, without touching the adapter', async () => {
    const adapter = { upsert: jest.fn() };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ text: '   ', metadata: {} }],
    } as any);

    expect(run.metrics.documentsCorrupted).toBe(1);
    expect(run.status).toBe(IngestionRunStatus.FAILED);
    expect(adapter.upsert).not.toHaveBeenCalled();
    expect(deadLettersRepo.save).toHaveBeenCalledWith([
      expect.objectContaining({ reason: expect.stringContaining('empty after cleaning') }),
    ]);
  });

  it('dead-letters a document whose metadata has a field not declared in the Phase 2 schema, without touching the adapter', async () => {
    const adapter = { upsert: jest.fn() };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: { unexpected_field: 'x' } }],
    } as any);

    expect(run.metrics.documentsCorrupted).toBe(1);
    expect(run.status).toBe(IngestionRunStatus.FAILED);
    expect(adapter.upsert).not.toHaveBeenCalled();
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(deadLettersRepo.save).toHaveBeenCalledWith([
      expect.objectContaining({ reason: expect.stringContaining("'unexpected_field'") }),
    ]);
  });

  it('skips chunks whose content hash was already stored (deduplication)', async () => {
    contentHashesRepo.findOne.mockResolvedValue({ id: 'existing-hash-row' });
    const adapter = { upsert: jest.fn() };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: {} }],
    } as any);

    expect(run.metrics.chunksDeduplicated).toBe(1);
    expect(run.metrics.chunksStored).toBe(0);
    expect(adapter.upsert).not.toHaveBeenCalled();
  });

  it('dead-letters a chunk whose embedding has the wrong dimension', async () => {
    embeddingClient.embed.mockResolvedValue({ vector: [0.1, 0.2], isLiveProvider: false }); // dimension 2, expected 4
    const adapter = { upsert: jest.fn() };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: {} }],
    } as any);

    expect(run.metrics.chunksDeadLettered).toBe(1);
    expect(run.status).toBe(IngestionRunStatus.FAILED);
    expect(adapter.upsert).not.toHaveBeenCalled();
  });

  it('retries embedding failures before dead-lettering, per the configured retry count', async () => {
    embeddingClient.embed.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue({ vector: [0.1, 0.2, 0.3, 0.4], isLiveProvider: false });
    const adapter = { upsert: jest.fn().mockResolvedValue(undefined) };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: {} }],
    } as any);

    expect(embeddingClient.embed).toHaveBeenCalledTimes(2);
    expect(run.metrics.chunksStored).toBe(1);
    expect(run.status).toBe(IngestionRunStatus.COMPLETED);
  });

  it('reports COMPLETED_WITH_ERRORS when some chunks succeed and others are dead-lettered', async () => {
    chunkingServiceMock.chunk.mockReturnValue(makeChunks(2));
    embeddingClient.embed.mockResolvedValueOnce({ vector: [0.1, 0.2, 0.3, 0.4], isLiveProvider: false }).mockResolvedValueOnce({ vector: [1, 2], isLiveProvider: false });
    const adapter = { upsert: jest.fn().mockResolvedValue(undefined) };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: {} }],
    } as any);

    expect(run.status).toBe(IngestionRunStatus.COMPLETED_WITH_ERRORS);
    expect(run.metrics.chunksStored).toBe(1);
    expect(run.metrics.chunksDeadLettered).toBe(1);
  });

  it('dead-letters the whole batch when storage fails after retries, without losing already-embedded work', async () => {
    const adapter = { upsert: jest.fn().mockRejectedValue(new Error('connection refused')) };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const run = await service.runIngestion('project-1', requester, {
      documents: [{ id: 'doc-1', text: 'hello world', metadata: { a: 1 } }],
    } as any);

    expect(run.status).toBe(IngestionRunStatus.FAILED);
    expect(run.metrics.chunksDeadLettered).toBe(1);
    expect(deadLettersRepo.save).toHaveBeenCalledWith([
      expect.objectContaining({ reason: expect.stringContaining('Storage failed'), payloadSnapshot: { text: 'chunk 0', metadata: { a: 1 } } }),
    ]);
  });

  it('retryDeadLetters re-embeds and re-stores dead letters that captured text, restoring their metadata', async () => {
    const adapter = { upsert: jest.fn().mockResolvedValue(undefined) };
    adapterFactory.getAdapter.mockReturnValue(adapter);
    runsRepo.findOne.mockResolvedValue({ id: 'run-1' });
    deadLettersRepo.find.mockResolvedValue([
      {
        id: 'dl-1',
        documentId: 'doc-1',
        chunkIndex: 0,
        reprocessed: false,
        payloadSnapshot: { text: 'chunk 0', metadata: { a: 1 } },
      },
    ]);

    const result = await service.retryDeadLetters('project-1', requester, 'run-1');

    expect(result).toEqual({ reprocessed: 1, stillFailed: 0 });
    expect(adapter.upsert).toHaveBeenCalledWith('docs', [
      expect.objectContaining({ id: 'doc-1::0', metadata: { a: 1 } }),
    ]);
  });

  it('retryDeadLetters skips dead letters with no captured text (e.g. corrupted documents)', async () => {
    runsRepo.findOne.mockResolvedValue({ id: 'run-1' });
    deadLettersRepo.find.mockResolvedValue([
      { id: 'dl-1', documentId: 'doc-1', reprocessed: false, payloadSnapshot: { metadata: {} } },
    ]);

    const result = await service.retryDeadLetters('project-1', requester, 'run-1');

    expect(result).toEqual({ reprocessed: 0, stillFailed: 0 });
  });
});
