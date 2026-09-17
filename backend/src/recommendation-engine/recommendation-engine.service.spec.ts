import { Test, TestingModule } from '@nestjs/testing';
import { RecommendationEngineService } from './recommendation-engine.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { LIVE_INGESTION_SUPPORTED, VectorPlatform } from '../projects/enums/platform.enum';
import { OperationalCapability, TenancyModel } from '../discovery/enums/discovery.enum';
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
  { id: 'oracle', label: 'Oracle Database (Vector)', operationalComplexity: 'medium', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'postgres_pgvector', label: 'PostgreSQL + pgvector', operationalComplexity: 'low', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'milvus', label: 'Milvus (Kubernetes)', operationalComplexity: 'high', requiresKubernetes: true, supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'pinecone', label: 'Pinecone', operationalComplexity: 'low', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'qdrant', label: 'Qdrant', operationalComplexity: 'medium', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'weaviate', label: 'Weaviate', operationalComplexity: 'medium', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'chroma', label: 'Chroma', operationalComplexity: 'low', supportsHybridSearch: false, supportsMetadataFiltering: true },
  { id: 'elasticsearch', label: 'Elasticsearch / OpenSearch', operationalComplexity: 'high', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'redis', label: 'Redis', operationalComplexity: 'medium', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'mongodb_atlas', label: 'MongoDB Atlas Vector Search', operationalComplexity: 'low', supportsHybridSearch: true, supportsMetadataFiltering: true },
  { id: 'lancedb', label: 'LanceDB', operationalComplexity: 'low', supportsHybridSearch: false, supportsMetadataFiltering: true },
  { id: 'actian', label: 'Actian Vector', operationalComplexity: 'medium', supportsHybridSearch: true, supportsMetadataFiltering: true },
];

function baseInput(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    estimatedVectorCount: 500_000,
    embeddingDimension: 768,
    qps: 20,
    peakQps: 40,
    targetP95LatencyMs: 200,
    targetP99LatencyMs: 400,
    recallTarget: 0.9,
    requiresReranking: false,
    hasExistingOracle: false,
    hasExistingPostgres: false,
    hasExistingKubernetes: false,
    existingPlatforms: [],
    containsPii: false,
    requiresHybridSearch: false,
    requiresFullTextSearch: false,
    requiresMetadataFiltering: false,
    operationalCapability: OperationalCapability.PART_TIME,
    requiresMultiRegion: false,
    tenancyModel: TenancyModel.SINGLE_TENANT,
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
      const risks: string[] = (service as any).buildRisks(VectorPlatform.ACTIAN, baseInput(), thresholds, false);
      expect(risks.some((r) => r.includes('No maintained Node.js driver exists'))).toBe(true);
    });

    it('does not flag the live-ingestion risk for one of the fully-implemented platforms', () => {
      const result = service.evaluate(baseInput({ hasExistingPostgres: true }));
      expect(result.decision).toBe(VectorPlatform.POSTGRES_PGVECTOR);
      expect(result.risks.some((r) => r.includes('No maintained Node.js driver exists'))).toBe(false);
    });
  });

  describe('search-capability eligibility', () => {
    it('disqualifies platforms that do not support hybrid search from winning, even at a scale where they would otherwise score highest', () => {
      const result = service.evaluate(baseInput({ estimatedVectorCount: 10_000, requiresHybridSearch: true }));
      const chroma = result.options.find((o) => o.platformId === VectorPlatform.CHROMA)!;
      const lancedb = result.options.find((o) => o.platformId === VectorPlatform.LANCEDB)!;
      expect(chroma.eligible).toBe(false);
      expect(lancedb.eligible).toBe(false);
      expect(chroma.ineligibleReasons[0]).toContain('hybrid');
      expect(result.decision).not.toBe(VectorPlatform.CHROMA);
      expect(result.decision).not.toBe(VectorPlatform.LANCEDB);
    });

    it('gives an ineligible platform a capability-gap rejection reason instead of a generic score comparison', () => {
      const result = service.evaluate(baseInput({ requiresHybridSearch: true }));
      const rejectedChroma = result.rejectedAlternatives.find((r) => r.platformId === VectorPlatform.CHROMA);
      expect(rejectedChroma?.reason).toContain('does not support hybrid');
    });

    it('does not disqualify any platform when no search capability is required', () => {
      const result = service.evaluate(baseInput());
      expect(result.options.every((o) => o.eligible)).toBe(true);
    });

    it('checkEligibility flags every required capability the catalog entry does not support', () => {
      const entry = { label: 'Test Platform', supportsHybridSearch: false, supportsMetadataFiltering: false };
      const reasons: string[] = (service as any).checkEligibility(
        entry,
        baseInput({ requiresHybridSearch: true, requiresFullTextSearch: true, requiresMetadataFiltering: true }),
      );
      expect(reasons).toHaveLength(3);
    });

    it('checkEligibility returns no reasons when the catalog entry supports everything required', () => {
      const entry = { label: 'Test Platform', supportsHybridSearch: true, supportsMetadataFiltering: true };
      const reasons: string[] = (service as any).checkEligibility(
        entry,
        baseInput({ requiresHybridSearch: true, requiresFullTextSearch: true, requiresMetadataFiltering: true }),
      );
      expect(reasons).toHaveLength(0);
    });
  });

  describe('existing-platform reuse (all 12 platforms)', () => {
    it('scores already running the exact platform as a stronger fit than only having a Kubernetes cluster', () => {
      const withCluster = service.evaluate(baseInput({ hasExistingKubernetes: true })).options.find((o) => o.platformId === VectorPlatform.QDRANT)!;
      const alreadyRunning = service
        .evaluate(baseInput({ hasExistingKubernetes: true, existingPlatforms: [VectorPlatform.QDRANT] }))
        .options.find((o) => o.platformId === VectorPlatform.QDRANT)!;
      expect(alreadyRunning.criteriaScores.existingPlatform).toBeGreaterThan(withCluster.criteriaScores.existingPlatform);
      expect(alreadyRunning.criteriaScores.existingPlatform).toBe(1.0);
    });

    it('gives a fully-managed SaaS platform a cost discount when already in use', () => {
      const fresh = service.evaluate(baseInput()).options.find((o) => o.platformId === VectorPlatform.PINECONE)!;
      const existing = service.evaluate(baseInput({ existingPlatforms: [VectorPlatform.PINECONE] })).options.find((o) => o.platformId === VectorPlatform.PINECONE)!;
      expect(existing.criteriaScores.cost).toBeGreaterThan(fresh.criteriaScores.cost);
    });

    it('gives Actian the same existing-platform/cost treatment as Oracle when already running it', () => {
      const fresh = service.evaluate(baseInput()).options.find((o) => o.platformId === VectorPlatform.ACTIAN)!;
      const existing = service.evaluate(baseInput({ existingPlatforms: [VectorPlatform.ACTIAN] })).options.find((o) => o.platformId === VectorPlatform.ACTIAN)!;
      expect(existing.criteriaScores.existingPlatform).toBe(1.0);
      expect(existing.criteriaScores.cost).toBeGreaterThan(fresh.criteriaScores.cost);
    });
  });

  describe('operational capability', () => {
    it('penalizes a high-operational-complexity platform further when the team has no operational capability', () => {
      const capable = service.evaluate(baseInput({ operationalCapability: OperationalCapability.PLATFORM_TEAM })).options.find((o) => o.platformId === VectorPlatform.ELASTICSEARCH)!;
      const none = service.evaluate(baseInput({ operationalCapability: OperationalCapability.NONE })).options.find((o) => o.platformId === VectorPlatform.ELASTICSEARCH)!;
      expect(none.criteriaScores.operationalComplexity).toBeLessThan(capable.criteriaScores.operationalComplexity);
    });

    it('does not penalize a low-operational-complexity platform regardless of capability', () => {
      const none = service.evaluate(baseInput({ operationalCapability: OperationalCapability.NONE })).options.find((o) => o.platformId === VectorPlatform.POSTGRES_PGVECTOR)!;
      const team = service.evaluate(baseInput({ operationalCapability: OperationalCapability.PLATFORM_TEAM })).options.find((o) => o.platformId === VectorPlatform.POSTGRES_PGVECTOR)!;
      expect(none.criteriaScores.operationalComplexity).toBe(team.criteriaScores.operationalComplexity);
    });
  });

  describe('additional captured parameters (P99, multi-region)', () => {
    it('flags a risk when the P99 target is tight relative to the P95 target', () => {
      const result = service.evaluate(baseInput({ targetP95LatencyMs: 200, targetP99LatencyMs: 220 }));
      expect(result.risks.some((r) => r.includes('P99 target is tight'))).toBe(true);
    });

    it('does not flag the P99 risk for a normally-proportioned tail-latency target', () => {
      const result = service.evaluate(baseInput({ targetP95LatencyMs: 200, targetP99LatencyMs: 400 }));
      expect(result.risks.some((r) => r.includes('P99 target is tight'))).toBe(false);
    });

    it('flags a risk when multi-region deployment is required', () => {
      const result = service.evaluate(baseInput({ requiresMultiRegion: true }));
      expect(result.risks.some((r) => r.includes('Multi-region deployment was requested'))).toBe(true);
    });
  });
});
