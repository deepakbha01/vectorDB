import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { BenchmarkService } from './benchmark.service';
import { OptimizationReport } from './optimization-report.entity';
import { ProjectsService } from '../projects/projects.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { bruteForceTopK } from './benchmark-math';

describe('BenchmarkService', () => {
  let service: BenchmarkService;
  let reportsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let indexDesignService: { getLatest: jest.Mock };
  let indexRecommendationEngine: { estimateMemoryGb: jest.Mock };
  let platformConfig: { getBenchmarkDefaults: jest.Mock; getIndexCatalog: jest.Mock };
  let adapterFactory: { getAdapter: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };
  const indexDesign = {
    decision: IndexType.HNSW,
    configuration: [
      { name: 'M', value: 16, description: '' },
      { name: 'efConstruction', value: 200, description: '' },
      { name: 'efSearch', value: 100, description: '' },
    ],
    inputsUsed: { dimension: 8, targetP95LatencyMs: 200, recallTarget: 0.5, metric: 'cosine' },
  };

  const benchmarkDefaults = {
    sampleSize: 20,
    queryCount: 5,
    topK: 3,
    costPerGbHourUsd: 0.05,
    hnsw: { searchParamName: 'efSearch', variants: [50, 100] },
  };

  function makeAdapter() {
    // A perfect in-memory ANN stand-in: returns the true brute-force top-K every time,
    // so recall is always 1.0 regardless of searchParams - lets tests focus on orchestration.
    const store: Array<{ id: string; vector: number[] }> = [];
    return {
      createSchema: jest.fn().mockResolvedValue(undefined),
      createVectorIndex: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockImplementation((_collection, records) => {
        store.push(...records.map((r: any) => ({ id: r.id, vector: r.vector })));
        return Promise.resolve();
      }),
      search: jest.fn().mockImplementation((_collection, query) => {
        const ids = bruteForceTopK(query.vector, store, query.topK);
        return Promise.resolve(ids.map((id) => ({ id, score: 1, metadata: {} })));
      }),
      dropSchema: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    reportsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'report-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    projectsService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1', platform: VectorPlatform.POSTGRES_PGVECTOR }),
      updatePhaseStatus: jest.fn().mockResolvedValue({}),
    };
    indexDesignService = { getLatest: jest.fn().mockResolvedValue(indexDesign) };
    indexRecommendationEngine = { estimateMemoryGb: jest.fn().mockReturnValue(2.5) };
    platformConfig = {
      getBenchmarkDefaults: jest.fn().mockReturnValue(benchmarkDefaults),
      getIndexCatalog: jest.fn().mockReturnValue([{ id: 'hnsw', memoryOverheadFactor: 1.7 }]),
    };
    adapterFactory = { getAdapter: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BenchmarkService,
        { provide: getRepositoryToken(OptimizationReport), useValue: reportsRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: IndexDesignService, useValue: indexDesignService },
        { provide: IndexRecommendationEngineService, useValue: indexRecommendationEngine },
        { provide: PlatformConfigService, useValue: platformConfig },
        { provide: VectorAdapterFactory, useValue: adapterFactory },
      ],
    }).compile();

    service = module.get(BenchmarkService);
  });

  it('rejects benchmarking before Phase 3 (Index Design) is complete', async () => {
    indexDesignService.getLatest.mockResolvedValue(null);
    await expect(service.runBenchmark('project-1', requester, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('provisions an ephemeral collection, benchmarks each variant, and always cleans up', async () => {
    const adapter = makeAdapter();
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const report: any = await service.runBenchmark('project-1', requester, {});

    expect(adapter.createSchema).toHaveBeenCalledWith(expect.objectContaining({ dimension: 8, metric: 'cosine' }));
    expect(adapter.createVectorIndex).toHaveBeenCalledWith(expect.any(String), IndexType.HNSW, indexDesign.configuration, 'cosine');
    expect(adapter.dropSchema).toHaveBeenCalledWith(expect.any(String), true);
    expect(report.variantResults).toHaveLength(2); // [50, 100] - baseline (100) already included
    expect(report.variantResults.every((v: any) => v.avgRecall === 1)).toBe(true);
    expect(report.variantResults.find((v: any) => v.isBaseline).searchParamValue).toBe(100);
  });

  it('still cleans up the ephemeral collection when a variant search throws', async () => {
    const adapter = makeAdapter();
    adapter.search.mockRejectedValueOnce(new Error('connection lost'));
    adapterFactory.getAdapter.mockReturnValue(adapter);

    await expect(service.runBenchmark('project-1', requester, {})).rejects.toThrow('connection lost');
    expect(adapter.dropSchema).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('deduplicates a variant list that already includes the baseline value', async () => {
    const adapter = makeAdapter();
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const report: any = await service.runBenchmark('project-1', requester, { variants: [100, 150] });

    const values = report.variantResults.map((v: any) => v.searchParamValue).sort((a: number, b: number) => a - b);
    expect(values).toEqual([100, 150]);
  });

  it('flags a latency bottleneck when every variant exceeds the target P95', async () => {
    const adapter = makeAdapter();
    adapter.search.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    adapterFactory.getAdapter.mockReturnValue(adapter);
    indexDesignService.getLatest.mockResolvedValue({ ...indexDesign, inputsUsed: { ...indexDesign.inputsUsed, targetP95LatencyMs: 0 } });

    const report: any = await service.runBenchmark('project-1', requester, {});

    expect(report.bottlenecks.some((b: string) => b.includes('0ms P95'))).toBe(true);
  });

  it('recommends the highest-recall variant among those meeting both latency and recall targets', async () => {
    const adapter = makeAdapter();
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const report: any = await service.runBenchmark('project-1', requester, {});

    // Every variant hits recall 1.0 in this stand-in adapter and the latency target (200ms) is generous,
    // so the recommendation should be well-formed and present among the tested variants.
    expect(report.variantResults.map((v: any) => v.searchParamValue)).toContain(report.recommendedVariant.searchParamValue);
    expect(report.recommendedVariant.avgRecall).toBeGreaterThanOrEqual(indexDesign.inputsUsed.recallTarget);
  });

  it('persists version 1 and marks the optimization phase completed', async () => {
    const adapter = makeAdapter();
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const report: any = await service.runBenchmark('project-1', requester, {});

    expect(report.version).toBe(1);
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
  });
});
