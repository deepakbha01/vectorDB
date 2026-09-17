import { Test, TestingModule } from '@nestjs/testing';
import { CapacityForecastEngineService } from './capacity-forecast-engine.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { CapacityForecastInput } from './capacity-forecast.types';

const thresholds = {
  availability: { highAvailabilityThreshold: 99.9 },
  infrastructureEstimation: {
    bytesPerDimension: 4,
    indexOverheadFactor: 1.5,
    ramSafetyFactor: 1.3,
    replicationFactor: 2,
    baselineCpuCoresPerMillionVectors: 0.5,
  },
  capacityPlanning: {
    forecastHorizonsMonths: [6, 12, 24],
    scalingTriggers: { memoryUtilizationPercent: 75, cpuUtilizationPercent: 70, storageUtilizationPercent: 80, qpsUtilizationPercent: 80 },
    cpuCoresPerThousandQps: 0.5,
    milvus: { queryNodeCapacityVectors: 20_000_000, dataNodeCapacityVectors: 50_000_000, replicaFactorForHa: 2 },
    embedded: { readReplicaQpsThreshold: 400, verticalScalingMaxCores: 64, partitioningVectorCountThreshold: 10_000_000 },
  },
};

const catalog = [
  { id: 'hnsw', label: 'HNSW', memoryOverheadFactor: 1.7 },
  { id: 'ivf_flat', label: 'IVF-Flat', memoryOverheadFactor: 1.1 },
];

function baseInput(overrides: Partial<CapacityForecastInput> = {}): CapacityForecastInput {
  return {
    currentVectorCount: 1_000_000,
    currentQps: 50,
    dimension: 768,
    availableMemoryGb: 64,
    availableCpuCores: 16,
    availableStorageGb: 500,
    monthlyGrowthPercent: 5,
    platform: VectorPlatform.POSTGRES_PGVECTOR,
    indexType: IndexType.HNSW,
    availabilityTargetPercent: 99.5,
    rpoMinutes: 60,
    rtoMinutes: 120,
    ...overrides,
  };
}

describe('CapacityForecastEngineService', () => {
  let service: CapacityForecastEngineService;
  let indexRecommendationEngine: { estimateMemoryGb: jest.Mock };

  beforeEach(async () => {
    indexRecommendationEngine = {
      estimateMemoryGb: jest.fn((_type, entry, vectorCount, dimension) => (vectorCount * dimension * 4 * entry.memoryOverheadFactor) / 1024 ** 3),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CapacityForecastEngineService,
        {
          provide: PlatformConfigService,
          useValue: { getThresholds: () => thresholds, getIndexCatalog: () => catalog },
        },
        { provide: IndexRecommendationEngineService, useValue: indexRecommendationEngine },
      ],
    }).compile();

    service = module.get(CapacityForecastEngineService);
  });

  it('produces one forecast entry per configured horizon, growing monotonically', () => {
    const result = service.forecast(baseInput());
    expect(result.forecast.map((f) => f.horizonMonths)).toEqual([6, 12, 24]);
    expect(result.forecast[0].projectedVectorCount).toBeGreaterThan(result.currentState.vectorCount);
    expect(result.forecast[1].projectedVectorCount).toBeGreaterThan(result.forecast[0].projectedVectorCount);
    expect(result.forecast[2].projectedVectorCount).toBeGreaterThan(result.forecast[1].projectedVectorCount);
  });

  it('compounds vector count growth monthly at the given growth rate', () => {
    const result = service.forecast(baseInput({ currentVectorCount: 1_000_000, monthlyGrowthPercent: 10 }));
    const sixMonth = result.forecast.find((f) => f.horizonMonths === 6)!;
    expect(sixMonth.projectedVectorCount).toBe(Math.round(1_000_000 * 1.1 ** 6));
  });

  it('flags a memory scaling trigger when projected memory exceeds available capacity', () => {
    const result = service.forecast(baseInput({ availableMemoryGb: 1, monthlyGrowthPercent: 20 }));
    expect(result.forecast.some((f) => f.scalingTriggersHit.some((t) => t.includes('Memory utilization')))).toBe(true);
  });

  it('reports no triggers when resources comfortably exceed projected need', () => {
    const result = service.forecast(baseInput({ availableMemoryGb: 100_000, availableCpuCores: 10_000, availableStorageGb: 100_000, monthlyGrowthPercent: 0.1 }));
    expect(result.forecast.every((f) => f.scalingTriggersHit.length === 0)).toBe(true);
  });

  it('recommends Kubernetes scaling and partitioning for Milvus', () => {
    const result = service.forecast(baseInput({ platform: VectorPlatform.MILVUS, currentVectorCount: 60_000_000, monthlyGrowthPercent: 10 }));
    expect(result.shardingRecommendation.strategy).toContain('Kubernetes');
    expect(result.shardingRecommendation.details.some((d) => d.includes('query nodes'))).toBe(true);
  });

  it('recommends a read replica for embedded platforms once projected QPS exceeds the threshold', () => {
    const result = service.forecast(baseInput({ currentQps: 300, monthlyGrowthPercent: 8 }));
    expect(result.shardingRecommendation.details.some((d) => d.includes('read replicas'))).toBe(true);
  });

  it('recommends Data Guard for Oracle high availability and RDS Multi-AZ for Postgres', () => {
    const oracleResult = service.forecast(baseInput({ platform: VectorPlatform.ORACLE, availabilityTargetPercent: 99.99 }));
    expect(oracleResult.haRecommendation[0]).toContain('Data Guard');

    const postgresResult = service.forecast(baseInput({ platform: VectorPlatform.POSTGRES_PGVECTOR, availabilityTargetPercent: 99.99 }));
    expect(postgresResult.haRecommendation[0]).toContain('Multi-AZ');
  });

  it('ties the DR backup cadence recommendation to the RPO target', () => {
    const result = service.forecast(baseInput({ rpoMinutes: 15 }));
    expect(result.drRecommendation[0]).toContain('15 minutes');
  });

  describe('newly added platform categories', () => {
    it('recommends Kubernetes shard_number/replication scaling for a self-hostable platform (Qdrant)', () => {
      const result = service.forecast(baseInput({ platform: VectorPlatform.QDRANT, currentVectorCount: 60_000_000, monthlyGrowthPercent: 10 }));
      expect(result.shardingRecommendation.strategy).toContain('Kubernetes');
      expect(result.shardingRecommendation.details.some((d) => d.includes('shard_number'))).toBe(true);
    });

    it('recommends vendor-managed scaling (no self-managed sharding) for a fully-managed SaaS platform (Pinecone)', () => {
      const result = service.forecast(baseInput({ platform: VectorPlatform.PINECONE, currentVectorCount: 60_000_000, monthlyGrowthPercent: 10 }));
      expect(result.shardingRecommendation.strategy).toContain('Vendor-managed');
      expect(result.shardingRecommendation.details.some((d) => d.includes('pod'))).toBe(true);
    });

    it('recommends application-level partitioning for an embedded library platform (LanceDB)', () => {
      const result = service.forecast(baseInput({ platform: VectorPlatform.LANCEDB, currentVectorCount: 60_000_000, monthlyGrowthPercent: 10 }));
      expect(result.shardingRecommendation.strategy).toContain('Application-level partitioning');
    });

    it('warns that Chroma has no built-in HA at a high availability target', () => {
      const result = service.forecast(baseInput({ platform: VectorPlatform.CHROMA, availabilityTargetPercent: 99.99 }));
      expect(result.haRecommendation[0]).toContain('no built-in HA');
    });

    it('recommends Redis Cluster/Sentinel for Redis at a high availability target', () => {
      const result = service.forecast(baseInput({ platform: VectorPlatform.REDIS, availabilityTargetPercent: 99.99 }));
      expect(result.haRecommendation[0]).toContain('Redis Cluster');
    });
  });
});
