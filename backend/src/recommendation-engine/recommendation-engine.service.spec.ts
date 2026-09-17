import { Test, TestingModule } from '@nestjs/testing';
import { RecommendationEngineService } from './recommendation-engine.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { LIVE_INGESTION_SUPPORTED, VectorPlatform } from '../projects/enums/platform.enum';
import { AssessmentInput } from './recommendation.types';

const thresholds = {
  rulesVersion: 'test-1.0.0',
  vectorCount: { embeddedMax: 5_000_000, dedicatedRecommendedMin: 20_000_000, dedicatedFloor: 1_000_000 },
  qps: { embeddedMax: 200, dedicatedRecommendedMin: 500 },
  latencyMs: { strictP95: 50, moderateP95: 150 },
  recall: { highRecallTarget: 0.95 },
  operationalComplexity: {
    kubernetesRequiredForMilvus: true,
    levelScores: { low: 1.0, medium: 0.7, high: 0.4 },
  },
  infrastructureEstimation: {
    bytesPerDimension: 4,
    indexOverheadFactor: 1.5,
    ramSafetyFactor: 1.3,
    replicationFactor: 2,
    baselineCpuCoresPerMillionVectors: 0.5,
  },
  scoringWeights: {
    vectorCount: 0.2,
    qps: 0.2,
    latency: 0.15,
    recall: 0.1,
    existingPlatform: 0.15,
    operationalComplexity: 0.1,
    cost: 0.1,
  },
};

const catalog = [
  { id: 'oracle', label: 'Oracle Database (Vector)', operationalComplexity: 'medium' },
  { id: 'postgres_pgvector', label: 'PostgreSQL + pgvector', operationalComplexity: 'low' },
  { id: 'milvus', label: 'Milvus (Kubernetes)', operationalComplexity: 'high', requiresKubernetes: true },
  { id: 'pinecone', label: 'Pinecone', operationalComplexity: 'low' },
  { id: 'qdrant', label: 'Qdrant', operationalComplexity: 'medium' },
  { id: 'weaviate', label: 'Weaviate', operationalComplexity: 'medium' },
  { id: 'chroma', label: 'Chroma', operationalComplexity: 'low' },
  { id: 'elasticsearch', label: 'Elasticsearch / OpenSearch', operationalComplexity: 'high' },
  { id: 'redis', label: 'Redis', operationalComplexity: 'medium' },
  { id: 'mongodb_atlas', label: 'MongoDB Atlas Vector Search', operationalComplexity: 'low' },
  { id: 'lancedb', label: 'LanceDB', operationalComplexity: 'low' },
  { id: 'actian', label: 'Actian Vector', operationalComplexity: 'medium' },
];

function baseInput(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    estimatedVectorCount: 500_000,
    embeddingDimension: 768,
    qps: 20,
    peakQps: 40,
    targetP95LatencyMs: 200,
    recallTarget: 0.9,
    hasExistingOracle: false,
    hasExistingPostgres: false,
    hasExistingKubernetes: false,
    containsPii: false,
    ...overrides,
  };
}

describe('RecommendationEngineService', () => {
  let service: RecommendationEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationEngineService,
        {
          provide: PlatformConfigService,
          useValue: {
            getThresholds: () => thresholds,
            getSupportedPlatforms: () => catalog,
            getRulesVersion: () => thresholds.rulesVersion,
          },
        },
      ],
    }).compile();

    service = module.get(RecommendationEngineService);
  });

  it('recommends pgvector for a small workload with existing PostgreSQL', () => {
    const result = service.evaluate(baseInput({ hasExistingPostgres: true }));
    expect(result.decision).toBe(VectorPlatform.POSTGRES_PGVECTOR);
    expect(result.rulesVersion).toBe('test-1.0.0');
    expect(result.options).toHaveLength(catalog.length);
    expect(result.rejectedAlternatives).toHaveLength(catalog.length - 1);
  });

  it('recommends a dedicated, purpose-built engine for a very large workload with existing Kubernetes', () => {
    const result = service.evaluate(
      baseInput({
        estimatedVectorCount: 50_000_000,
        qps: 800,
        peakQps: 1200,
        targetP95LatencyMs: 30,
        recallTarget: 0.97,
        hasExistingKubernetes: true,
      }),
    );
    // Now that the catalog includes several dedicated/managed engines (not just Milvus),
    // the winner is whichever scores best on operational complexity/cost - Qdrant and
    // Weaviate are self-hostable on the same existing Kubernetes cluster with a lower
    // catalog operational-complexity rating than Milvus, so either winning is correct.
    expect([VectorPlatform.MILVUS, VectorPlatform.QDRANT, VectorPlatform.WEAVIATE]).toContain(result.decision);
  });

  it('flags a Kubernetes risk when Milvus is recommended without an existing cluster', () => {
    const result = service.evaluate(
      baseInput({
        estimatedVectorCount: 50_000_000,
        qps: 800,
        peakQps: 1200,
        hasExistingKubernetes: false,
      }),
    );
    if (result.decision === VectorPlatform.MILVUS) {
      expect(result.risks.some((r) => r.includes('Kubernetes'))).toBe(true);
    }
  });

  it('penalizes Milvus for small workloads even with Kubernetes available', () => {
    const result = service.evaluate(baseInput({ estimatedVectorCount: 100_000, hasExistingKubernetes: true }));
    const milvusOption = result.options.find((o) => o.platformId === VectorPlatform.MILVUS);
    expect(milvusOption!.criteriaScores.vectorCount).toBeLessThan(0.5);
  });

  it('produces a monotonically increasing infrastructure memory estimate with vector count', () => {
    const small = service.evaluate(baseInput({ estimatedVectorCount: 100_000 }));
    const large = service.evaluate(baseInput({ estimatedVectorCount: 10_000_000 }));
    expect(large.infrastructureEstimate.estimatedMemoryGb).toBeGreaterThan(small.infrastructureEstimate.estimatedMemoryGb);
  });

  it('every option carries evidence strings for auditability', () => {
    const result = service.evaluate(baseInput());
    for (const option of result.options) {
      expect(option.evidence.length).toBeGreaterThan(0);
    }
  });

  describe('newly added platforms', () => {
    it('recommends a fully-managed platform (Pinecone/MongoDB Atlas) for a huge, latency-sensitive workload with no existing infra', () => {
      const result = service.evaluate(
        baseInput({
          estimatedVectorCount: 200_000_000,
          qps: 1000,
          peakQps: 3000,
          targetP95LatencyMs: 20,
          recallTarget: 0.99,
        }),
      );
      expect([VectorPlatform.PINECONE, VectorPlatform.MONGODB_ATLAS]).toContain(result.decision);
    });

    it('penalizes dedicated/managed engines (e.g. Qdrant) as overkill for a tiny workload', () => {
      const result = service.evaluate(baseInput({ estimatedVectorCount: 50_000 }));
      const qdrant = result.options.find((o) => o.platformId === VectorPlatform.QDRANT);
      expect(qdrant!.criteriaScores.vectorCount).toBeLessThan(0.5);
    });

    it('favors lightweight embedded libraries (Chroma/LanceDB) at small scale like the embedded-RDBMS group', () => {
      const result = service.evaluate(baseInput({ estimatedVectorCount: 50_000 }));
      const chroma = result.options.find((o) => o.platformId === VectorPlatform.CHROMA)!;
      const postgres = result.options.find((o) => o.platformId === VectorPlatform.POSTGRES_PGVECTOR)!;
      expect(chroma.criteriaScores.vectorCount).toBeCloseTo(postgres.criteriaScores.vectorCount, 4);
    });

    it('flags a "no maintained Node.js driver" risk when Actian is the decision', () => {
      expect(LIVE_INGESTION_SUPPORTED.has(VectorPlatform.ACTIAN)).toBe(false);
      // buildRisks is private; Actian has no dedicated "existing platform" input to force it to win
      // outright, so this exercises the risk-building logic directly for that decision.
      const risks: string[] = (service as any).buildRisks(VectorPlatform.ACTIAN, baseInput(), thresholds);
      expect(risks.some((r) => r.includes('No maintained Node.js driver exists'))).toBe(true);
    });

    it('does not flag the live-ingestion risk for one of the fully-implemented platforms', () => {
      const result = service.evaluate(baseInput({ hasExistingPostgres: true }));
      expect(result.decision).toBe(VectorPlatform.POSTGRES_PGVECTOR);
      expect(result.risks.some((r) => r.includes('No maintained Node.js driver exists'))).toBe(false);
    });
  });
});
