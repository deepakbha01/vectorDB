/**
 * GOLDEN-MASTER (characterisation) TESTS - AI Factory Wave 0 safety net.
 *
 * Freezes the current output of every existing decision engine for a fixed
 * set of representative inputs, using the REAL production configuration in
 * backend/config/*.yaml (not test fixtures). Any change to a decision, score,
 * generated DDL/IaC, or config value makes these fail, so AI Factory work
 * cannot silently alter the existing VectorDB workflow.
 *
 * If a change is INTENDED (engine fix, config update), review the snapshot
 * diff and accept it deliberately:
 *     npm run test:golden -- -u
 * and explain the behaviour change in the commit message.
 */
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import { AssessmentInput } from '../recommendation-engine/recommendation.types';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { IndexRecommendationInput } from '../index-recommendation-engine/index-recommendation.types';
import { UpdateFrequency } from '../index-recommendation-engine/enums/update-frequency.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { CapacityForecastEngineService } from '../capacity-planning/capacity-forecast-engine.service';
import { CapacityForecastInput } from '../capacity-planning/capacity-forecast.types';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { IacGeneratorService } from '../deployment/iac-generator.service';
import { ChunkingService } from '../chunking/chunking.service';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { InferenceConfigService } from '../inference/inference-config.service';
import { InferenceEngineService } from '../inference/inference-engine.service';
import { GpuPricingModel, InferenceEngineInput, InferenceOpsCapability, InferenceWorkloadType, ModelSourcing } from '../inference/inference.types';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { DataReplicationModel, OperationalCapability, QpsScope, SimilarityMetric, TenancyModel } from '../discovery/enums/discovery.enum';

// ----------------------------------------------------- numeric stability
// Snapshots compare non-integer numbers at 12 significant digits. Different
// Node / V8 versions can differ in the last binary digit of the same float
// computation (e.g. 1089.9240005276854 vs ...858), which is not a behaviour
// change. 12 digits is still far finer than any cost, latency or score the
// engines produce, so every real change is still caught.
const SIGNIFICANT_DIGITS = 12;
expect.addSnapshotSerializer({
  test: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v),
  serialize: (v: number) => String(Number(v.toPrecision(SIGNIFICANT_DIGITS))),
});

// ---------------------------------------------------------------- real config
const CONFIG_DIR = path.join(__dirname, '../../config');
const CONFIG_PATHS: Record<string, string> = {
  THRESHOLDS_CONFIG_PATH: 'thresholds.yaml',
  DATABASES_CONFIG_PATH: 'databases.yaml',
  EMBEDDINGS_CONFIG_PATH: 'embeddings.yaml',
  INDEXES_CONFIG_PATH: 'indexes.yaml',
  INFRASTRUCTURE_CONFIG_PATH: 'infrastructure.yaml',
  PATTERNS_CONFIG_PATH: 'patterns.yaml',
  INFERENCE_CONFIG_PATH: 'inference.yaml',
};
const configService = { get: (key: string) => (CONFIG_PATHS[key] ? path.join(CONFIG_DIR, CONFIG_PATHS[key]) : undefined) } as unknown as ConfigService;

const platformConfig = new PlatformConfigService(configService);
platformConfig.onModuleInit();
const inferenceConfig = new InferenceConfigService(configService);
inferenceConfig.onModuleInit();

const recommendationEngine = new RecommendationEngineService(platformConfig);
const indexEngine = new IndexRecommendationEngineService(platformConfig);
const capacityEngine = new CapacityForecastEngineService(platformConfig, indexEngine);
const schemaGenerator = new SchemaGeneratorService();
const iacGenerator = new IacGeneratorService();
const chunking = new ChunkingService();
const embeddings = new EmbeddingsService(platformConfig);
const inferenceEngine = new InferenceEngineService(inferenceConfig);

const ALL_PLATFORMS = Object.values(VectorPlatform).filter((p) => p !== VectorPlatform.UNDETERMINED);

// ------------------------------------------------------------- Phase 1 inputs
function assessment(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
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
    dataReplicationModel: DataReplicationModel.NONE,
    regionalFailoverRequired: false,
    crossRegionReplicationRequired: false,
    qpsScope: QpsScope.AGGREGATE,
    requiresKeyManagement: false,
    requiresTenantIsolation: false,
    requiresAuditLogging: false,
    requiresEncryptionAtRest: false,
    requiresEncryptionInTransit: false,
    requiresAuthentication: false,
    requiresRbac: false,
    rpoMinutes: 60,
    rtoMinutes: 240,
    retentionDays: 365,
    ...overrides,
  };
}

const PHASE1_SCENARIOS: Record<string, Partial<AssessmentInput>> = {
  'small greenfield': {},
  'existing PostgreSQL estate': { hasExistingPostgres: true, requiresMetadataFiltering: true },
  'existing Oracle estate': { hasExistingOracle: true, estimatedVectorCount: 3_000_000 },
  'large scale on Kubernetes with a platform team': {
    estimatedVectorCount: 200_000_000,
    embeddingDimension: 1536,
    qps: 2500,
    peakQps: 5000,
    targetP95LatencyMs: 30,
    targetP99LatencyMs: 60,
    recallTarget: 0.97,
    hasExistingKubernetes: true,
    operationalCapability: OperationalCapability.PLATFORM_TEAM,
  },
  'hybrid + full-text search with reranking': { requiresHybridSearch: true, requiresFullTextSearch: true, requiresReranking: true, requiresMetadataFiltering: true },
  'regulated multi-region multi-tenant': {
    estimatedVectorCount: 20_000_000,
    qps: 300,
    peakQps: 900,
    containsPii: true,
    requiresMultiRegion: true,
    deploymentRegionCount: 2,
    dataReplicationModel: DataReplicationModel.ACTIVE_ACTIVE,
    regionalFailoverRequired: true,
    crossRegionReplicationRequired: true,
    tenancyModel: TenancyModel.SHARED_MULTI_TENANT,
    requiresTenantIsolation: true,
    requiresKeyManagement: true,
    requiresAuditLogging: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    requiresAuthentication: true,
    requiresRbac: true,
    dataResidencyRequirement: 'EU',
    rpoMinutes: 5,
    rtoMinutes: 30,
  },
  'tight budget at mid scale': { estimatedVectorCount: 50_000_000, qps: 400, peakQps: 800, monthlyBudgetUsd: 300 },
  'no operations capability': { operationalCapability: OperationalCapability.NONE, estimatedVectorCount: 30_000_000, qps: 600 },
};

describe('Golden master - existing VectorDB workflow (must not change unintentionally)', () => {
  describe('Phase 1 - Architecture Decision Engine', () => {
    it('lists the same candidate platforms', () => {
      expect(recommendationEngine.listCandidatePlatforms().map((p) => p.id)).toMatchSnapshot();
    });

    for (const [name, overrides] of Object.entries(PHASE1_SCENARIOS)) {
      it(`decision record: ${name}`, () => {
        expect(recommendationEngine.evaluate(assessment(overrides))).toMatchSnapshot();
      });
    }

    it('sensitivity analysis', () => {
      const result = recommendationEngine.runSensitivityAnalysis(assessment(), [
        { name: '10x vectors', overrides: { estimatedVectorCount: 5_000_000 } },
        { name: '100x vectors and QPS', overrides: { estimatedVectorCount: 50_000_000, qps: 2000, peakQps: 4000 } },
        { name: 'existing PostgreSQL', overrides: { hasExistingPostgres: true } },
      ]);
      expect(result).toMatchSnapshot();
    });
  });

  describe('Phase 2 - chunking and embedding catalogue', () => {
    const text = [
      'Vector databases store embeddings. They support similarity search at scale.',
      '',
      'Retrieval-augmented generation grounds a model in enterprise documents. Chunking strategy affects recall.',
      '',
      'Index choice trades recall, latency and memory. HNSW is memory-hungry; IVF and PQ trade recall for footprint.',
    ].join('\n');

    for (const strategy of Object.values(ChunkingStrategy)) {
      it(`chunking: ${strategy}`, () => {
        const result = chunking.chunk(text, { strategy, chunkSize: 80, chunkOverlap: 10 } as any);
        expect({ stats: result.stats, chunks: result.chunks.map((c) => c.text) }).toMatchSnapshot();
      });
    }

    it('embedding provider catalogue', () => {
      expect(embeddings.getCatalog()).toMatchSnapshot();
    });
  });

  describe('Phase 3 - Index Recommendation Engine', () => {
    const scenarios: Record<string, IndexRecommendationInput> = {
      'small static corpus': { vectorCount: 500_000, dimension: 768, availableMemoryGb: 32, qps: 20, recallTarget: 0.9, targetP95LatencyMs: 200, topK: 10, updateFrequency: UpdateFrequency.STATIC },
      'large, high recall, frequent updates': { vectorCount: 100_000_000, dimension: 1536, availableMemoryGb: 512, qps: 1500, recallTarget: 0.97, targetP95LatencyMs: 50, topK: 20, updateFrequency: UpdateFrequency.HIGH },
      'memory constrained': { vectorCount: 50_000_000, dimension: 1024, availableMemoryGb: 32, qps: 200, recallTarget: 0.85, targetP95LatencyMs: 150, topK: 10, updateFrequency: UpdateFrequency.LOW },
    };
    for (const [name, input] of Object.entries(scenarios)) {
      it(`index decision: ${name}`, () => {
        expect(indexEngine.evaluate(input)).toMatchSnapshot();
      });
    }
  });

  describe('Phase 2/3 - schema and index artefacts for every platform', () => {
    const schemaInput = {
      collectionName: 'enterprise_docs',
      dimension: 768,
      metric: SimilarityMetric.COSINE,
      metadataFields: [
        { name: 'tenant_id', type: 'string' as const, required: true, filterable: true },
        { name: 'published_at', type: 'date' as const, filterable: true },
        { name: 'title', type: 'string' as const, searchable: true },
        { name: 'page', type: 'number' as const, filterable: false },
      ],
    };

    it('generated schemas (all platforms)', () => {
      expect(schemaGenerator.generateAll(schemaInput)).toMatchSnapshot();
    });

    for (const platform of ALL_PLATFORMS) {
      it(`index artefacts: ${platform}`, () => {
        expect({
          hnsw: schemaGenerator.generateIndexArtifact(platform, 'enterprise_docs', IndexType.HNSW, [
            { name: 'M', value: 16 },
            { name: 'efConstruction', value: 200 },
            { name: 'efSearch', value: 100 },
          ]),
          ivfFlat: schemaGenerator.generateIndexArtifact(platform, 'enterprise_docs', IndexType.IVF_FLAT, [
            { name: 'nlist', value: 1024 },
            { name: 'nprobe', value: 16 },
          ], SimilarityMetric.EUCLIDEAN),
        }).toMatchSnapshot();
      });
    }
  });

  describe('Phase 5 - deployment artefacts for every platform', () => {
    for (const platform of ALL_PLATFORMS) {
      it(`IaC and runbooks: ${platform}`, () => {
        expect({
          terraform: iacGenerator.generateTerraform(platform, 'Golden Master Project'),
          kubernetes: iacGenerator.generateKubernetesArtifacts(platform, 'enterprise_docs'),
          healthCheck: iacGenerator.getHealthCheckDefinition(platform),
          rollback: iacGenerator.getRollbackProcedure(platform),
          checklist: iacGenerator.getDeploymentChecklist(platform),
        }).toMatchSnapshot();
      });
    }
  });

  describe('Phase 8 - Capacity Forecast Engine', () => {
    const base: CapacityForecastInput = {
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
    };
    const scenarios: Record<string, Partial<CapacityForecastInput>> = {
      'pgvector HNSW, moderate growth': {},
      'Oracle IVF, high availability': { platform: VectorPlatform.ORACLE, indexType: IndexType.IVF_FLAT, availabilityTargetPercent: 99.95, rpoMinutes: 5, rtoMinutes: 15 },
      'Milvus at scale, fast growth': { platform: VectorPlatform.MILVUS, currentVectorCount: 80_000_000, currentQps: 1500, monthlyGrowthPercent: 12, availableMemoryGb: 512, availableCpuCores: 64 },
      'Pinecone (managed SaaS)': { platform: VectorPlatform.PINECONE, currentVectorCount: 10_000_000, currentQps: 300 },
      'LanceDB (embedded)': { platform: VectorPlatform.LANCEDB, currentVectorCount: 5_000_000 },
    };
    for (const [name, overrides] of Object.entries(scenarios)) {
      it(`capacity plan: ${name}`, () => {
        expect(capacityEngine.forecast({ ...base, ...overrides })).toMatchSnapshot();
      });
    }
  });

  describe('Inference Assessment track', () => {
    const input = (overrides: Partial<InferenceEngineInput> = {}): InferenceEngineInput => ({
      workloadType: InferenceWorkloadType.RAG,
      modelSourcing: ModelSourcing.EVALUATE_BOTH,
      model: inferenceConfig.getModels().find((m) => m.id === 'llama-3.3-70b')!,
      precision: 'auto',
      managedApiTier: inferenceConfig.getManagedApiTiers().find((t) => t.id === 'mid')!,
      requestsPerDay: 100_000,
      peakToAverageRatio: 3,
      avgInputTokens: 2000,
      avgOutputTokens: 300,
      maxContextTokens: 8192,
      ttftTargetMs: 2000,
      tpotTargetMs: 50,
      availabilityTargetPercent: 99.9,
      gpuPricing: GpuPricingModel.ON_DEMAND,
      autoscaling: true,
      allowThirdPartyApi: true,
      containsPii: false,
      monthlyGrowthPercent: 5,
      opsCapability: InferenceOpsCapability.DEDICATED_TEAM,
      ...overrides,
    });
    it('70B RAG, compare self-hosted and API', () => {
      expect(inferenceEngine.assess(input())).toMatchSnapshot();
    });
    it('8B chat, API not allowed, reserved GPUs', () => {
      expect(
        inferenceEngine.assess(
          input({ model: inferenceConfig.getModels().find((m) => m.id === 'llama-3.1-8b')!, workloadType: InferenceWorkloadType.CHAT, allowThirdPartyApi: false, gpuPricing: GpuPricingModel.RESERVED_1YR }),
        ),
      ).toMatchSnapshot();
    });
  });
});
