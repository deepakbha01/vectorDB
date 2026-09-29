import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { BenchmarkService, EXACT_SCAN_NOTE, runConcurrently } from './benchmark.service';
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
  let adapterFactory: { getAdapter: jest.Mock; forProject: jest.Mock };

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
    adapterFactory = { getAdapter: jest.fn(), forProject: jest.fn(async (p: { platform: unknown }) => adapterFactory.getAdapter(p.platform)) };

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
    // Each variant: one pass one-at-a-time (latency, recall) + one load pass with parallel clients (throughput).
    expect(adapter.search).toHaveBeenCalledTimes(2 * 2 * benchmarkDefaults.queryCount);
    for (const v of report.variantResults) {
      expect(v.concurrency).toBe(4);
      expect(v.sustainedQps).toBeGreaterThan(0);
    }
  });

  it('uses the requested number of parallel clients for the load pass', async () => {
    const adapter = makeAdapter();
    adapterFactory.getAdapter.mockReturnValue(adapter);
    const report: any = await service.runBenchmark('project-1', requester, { concurrency: 2 });
    expect(report.variantResults.every((v: any) => v.concurrency === 2)).toBe(true);
    expect(report.searchMode).toBe('ann'); // adapters without a fallback always search their index
  });

  it('records an exact scan (no pgvector), skips the load pass and says the results are not representative', async () => {
    const adapter: any = { ...makeAdapter(), searchMode: jest.fn().mockResolvedValue('exact_scan') };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const report: any = await service.runBenchmark('project-1', requester, {});

    expect(report.searchMode).toBe('exact_scan');
    // Baseline only (the parameter is ignored on a scan), one-at-a-time, at most 20 queries.
    expect(report.variantResults.map((v: any) => v.searchParamValue)).toEqual([100]);
    expect(adapter.search).toHaveBeenCalledTimes(benchmarkDefaults.queryCount);
    expect(report.queryCount).toBe(benchmarkDefaults.queryCount);
    expect(report.variantResults.every((v: any) => v.sustainedQps === undefined && v.concurrency === undefined)).toBe(true);
    expect(report.bottlenecks).toEqual([EXACT_SCAN_NOTE]);
    expect(adapter.dropSchema).toHaveBeenCalledWith(expect.any(String), true);
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

describe('runConcurrently', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runConcurrently([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      await sleep(1);
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('runs up to `workers` items at once, so wall-clock time is far below the one-at-a-time total', async () => {
    let active = 0;
    let peak = 0;
    const ms = await runConcurrently(Array.from({ length: 8 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(40);
      active--;
    });
    expect(peak).toBe(4);
    // 8 items x 40ms one at a time would be 320ms; 4 at a time is about 80ms.
    expect(ms).toBeLessThan(250);
  });

  it('never starts more workers than there are items', async () => {
    let peak = 0;
    let active = 0;
    await runConcurrently([1, 2], 10, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
    });
    expect(peak).toBe(2);
  });
});
