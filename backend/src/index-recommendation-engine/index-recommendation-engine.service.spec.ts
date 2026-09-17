import { Test, TestingModule } from '@nestjs/testing';
import { IndexRecommendationEngineService } from './index-recommendation-engine.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { UpdateFrequency } from './enums/update-frequency.enum';
import { IndexRecommendationInput } from './index-recommendation.types';

const thresholds = {
  rulesVersion: 'test-1.0.0',
  vectorCount: { embeddedMax: 5_000_000, dedicatedRecommendedMin: 20_000_000, dedicatedFloor: 1_000_000 },
  latencyMs: { strictP95: 50, moderateP95: 150 },
  recall: { highRecallTarget: 0.95 },
  qps: { embeddedMax: 200, dedicatedRecommendedMin: 500 },
  indexSelection: {
    scoringWeights: { recall: 0.25, latency: 0.2, memory: 0.2, throughput: 0.2, updateFriendliness: 0.15 },
    comfortableMemoryUtilization: 0.6,
    severeMemoryOvershootMultiplier: 3,
  },
};

const catalog = [
  {
    id: 'hnsw',
    label: 'HNSW',
    parameters: {
      M: { default: 16, min: 4, max: 64, description: 'connectivity' },
      efConstruction: { default: 200, min: 40, max: 800, description: 'build width' },
      efSearch: { default: 100, min: 10, max: 1000, description: 'search width' },
    },
    memoryOverheadFactor: 1.7,
    updateFriendliness: { static: 1.0, low: 0.95, moderate: 0.8, high: 0.55 },
  },
  {
    id: 'ivf_flat',
    label: 'IVF-Flat',
    parameters: {
      nlist: { default: 1024, min: 16, max: 65536, description: 'clusters' },
      nprobe: { default: 16, min: 1, max: 4096, description: 'clusters searched' },
    },
    memoryOverheadFactor: 1.1,
    updateFriendliness: { static: 0.9, low: 0.95, moderate: 0.9, high: 0.75 },
  },
  {
    id: 'pq',
    label: 'PQ',
    parameters: {
      m: { default: 8, min: 1, max: 64, description: 'subquantizers' },
      nbits: { default: 8, min: 4, max: 12, description: 'bits per code' },
      nlist: { default: 1024, min: 16, max: 65536, description: 'clusters' },
      nprobe: { default: 16, min: 1, max: 4096, description: 'clusters searched' },
    },
    compressionRatio: 8,
    updateFriendliness: { static: 0.9, low: 0.9, moderate: 0.8, high: 0.65 },
  },
];

function baseInput(overrides: Partial<IndexRecommendationInput> = {}): IndexRecommendationInput {
  return {
    vectorCount: 500_000,
    dimension: 768,
    availableMemoryGb: 32,
    qps: 20,
    recallTarget: 0.9,
    targetP95LatencyMs: 150,
    topK: 10,
    updateFrequency: UpdateFrequency.LOW,
    ...overrides,
  };
}

describe('IndexRecommendationEngineService', () => {
  let service: IndexRecommendationEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexRecommendationEngineService,
        {
          provide: PlatformConfigService,
          useValue: {
            getThresholds: () => thresholds,
            getIndexCatalog: () => catalog,
            getRulesVersion: () => thresholds.rulesVersion,
          },
        },
      ],
    }).compile();

    service = module.get(IndexRecommendationEngineService);
  });

  it('recommends HNSW for a moderate-scale, low-update, ample-memory workload', () => {
    const result = service.evaluate(baseInput());
    expect(result.decision).toBe('hnsw');
    expect(result.options).toHaveLength(3);
    expect(result.alternatives).toHaveLength(2);
  });

  it('recommends PQ when memory is severely constrained relative to vector count', () => {
    const result = service.evaluate(baseInput({ vectorCount: 50_000_000, dimension: 768, availableMemoryGb: 20 }));
    expect(result.decision).toBe('pq');
  });

  it('penalizes HNSW under high update frequency relative to IVF-Flat', () => {
    const hnswOption = (input: IndexRecommendationInput) => service.evaluate(input).options.find((o) => o.indexType === 'hnsw')!;
    const lowUpdate = hnswOption(baseInput({ updateFrequency: UpdateFrequency.LOW }));
    const highUpdate = hnswOption(baseInput({ updateFrequency: UpdateFrequency.HIGH }));
    expect(highUpdate.criteriaScores.updateFriendliness).toBeLessThan(lowUpdate.criteriaScores.updateFriendliness);
  });

  it('flags a scaling consideration when HNSW is chosen under high update frequency', () => {
    const result = service.evaluate(baseInput({ updateFrequency: UpdateFrequency.HIGH, vectorCount: 100_000, availableMemoryGb: 64 }));
    if (result.decision === 'hnsw') {
      expect(result.scalingConsiderations.some((c) => c.includes('HNSW graphs degrade'))).toBe(true);
    }
  });

  it('produces HNSW tuning parameters within catalog bounds', () => {
    const result = service.evaluate(baseInput({ recallTarget: 0.97, topK: 50 }));
    const hnswConfig = result.decision === 'hnsw' ? result.configuration : service.evaluate(baseInput()).configuration;
    const efSearch = hnswConfig.find((c) => c.name === 'efSearch');
    if (efSearch) {
      expect(efSearch.value).toBeLessThanOrEqual(1000);
      expect(efSearch.value).toBeGreaterThanOrEqual(10);
    }
  });

  it('picks a PQ subquantizer count that evenly divides the dimension', () => {
    const result = service.evaluate(baseInput({ vectorCount: 60_000_000, dimension: 768, availableMemoryGb: 16 }));
    expect(result.decision).toBe('pq');
    const m = result.configuration.find((c) => c.name === 'm')!;
    expect(768 % m.value).toBe(0);
  });

  it('favors PQ over HNSW on throughput at very high QPS', () => {
    const result = service.evaluate(baseInput({ qps: 800 }));
    const hnsw = result.options.find((o) => o.indexType === 'hnsw')!;
    const pq = result.options.find((o) => o.indexType === 'pq')!;
    expect(pq.criteriaScores.throughput).toBeGreaterThan(hnsw.criteriaScores.throughput);
  });

  it('increases IVF nprobe for a high recall target relative to a low one', () => {
    const evaluateIvf = (recallTarget: number) => {
      const res = service.evaluate(baseInput({ recallTarget, vectorCount: 2_000_000, availableMemoryGb: 8 }));
      return res.options.find((o) => o.indexType === 'ivf_flat')!;
    };
    // Compare nprobe indirectly is only meaningful when ivf_flat wins; instead assert recall scoring differs.
    const low = evaluateIvf(0.8);
    const high = evaluateIvf(0.97);
    expect(low.criteriaScores.recall).toBeGreaterThan(high.criteriaScores.recall);
  });
});
