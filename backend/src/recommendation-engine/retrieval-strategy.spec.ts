import { PlatformConfigService } from '../common/config/platform-config.service';
import {
  ContentChangeFrequency,
  ContentModality,
  DataReplicationModel,
  DocumentStructure,
  ExplainabilityNeed,
  OperationalCapability,
  QpsScope,
  TenancyModel,
} from '../discovery/enums/discovery.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { RecommendationEngineService } from './recommendation-engine.service';
import { AssessmentInput } from './recommendation.types';
import { evaluateRetrievalStrategy, hasRetrievalStrategyInputs } from './retrieval-strategy';

// Uses the shipped config/thresholds.yaml and config/databases.yaml, so the tests cover the real settings.
const config = new PlatformConfigService({ get: () => undefined } as any);
config.onModuleInit();
const cfg = config.getThresholds().retrievalStrategy;

function input(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    estimatedVectorCount: 200_000,
    embeddingDimension: 1536,
    qps: 1,
    peakQps: 3,
    targetP95LatencyMs: 8000,
    targetP99LatencyMs: 12000,
    recallTarget: 0.9,
    requiresReranking: false,
    hasExistingOracle: false,
    hasExistingPostgres: true,
    hasExistingKubernetes: false,
    existingPlatforms: [],
    containsPii: false,
    requiresHybridSearch: false,
    requiresFullTextSearch: true,
    requiresMetadataFiltering: true,
    operationalCapability: OperationalCapability.PART_TIME,
    requiresMultiRegion: false,
    tenancyModel: TenancyModel.SINGLE_TENANT,
    dataReplicationModel: DataReplicationModel.NONE,
    regionalFailoverRequired: false,
    crossRegionReplicationRequired: false,
    qpsScope: QpsScope.AGGREGATE,
    requiresKeyManagement: false,
    requiresTenantIsolation: false,
    requiresAuditLogging: true,
    requiresEncryptionAtRest: false,
    requiresEncryptionInTransit: false,
    requiresAuthentication: false,
    requiresRbac: false,
    rpoMinutes: 60,
    rtoMinutes: 240,
    retentionDays: 365,
    // 300 long structured documents (~120 KB each) - the classic vectorless case
    documentCount: 300,
    avgDocumentSizeKb: 120,
    documentStructure: DocumentStructure.STRUCTURED,
    contentModality: ContentModality.TEXT_AND_TABLES,
    contentChangeFrequency: ContentChangeFrequency.WEEKLY,
    explainabilityNeed: ExplainabilityNeed.HIGH,
    queryMixExactPercent: 30,
    queryMixMultiHopPercent: 35,
    queryMixSemanticPercent: 20,
    queryMixAnalyticsPercent: 10,
    queryMixRelationshipPercent: 5,
    ...overrides,
  };
}

/** Short, semantic-heavy, fast-answer workload over a large corpus - the classic vector case. */
const vectorWorkload: Partial<AssessmentInput> = {
  documentCount: 2_000_000,
  avgDocumentSizeKb: 4,
  documentStructure: DocumentStructure.SHORT_SNIPPETS,
  contentModality: ContentModality.TEXT,
  contentChangeFrequency: ContentChangeFrequency.DAILY,
  explainabilityNeed: ExplainabilityNeed.STANDARD,
  queryMixExactPercent: 10,
  queryMixMultiHopPercent: 5,
  queryMixSemanticPercent: 85,
  queryMixAnalyticsPercent: 0,
  queryMixRelationshipPercent: 0,
  qps: 40,
  peakQps: 120,
  targetP95LatencyMs: 1500,
};

describe('Retrieval Strategy Assessment', () => {
  it('ships its settings in thresholds.yaml', () => {
    expect(cfg).toBeDefined();
    expect(cfg.contextWindowTokens).toBeGreaterThan(0);
    expect(Object.values(cfg.weights).every((w) => typeof w === 'number' && w >= 0)).toBe(true);
  });

  it('does not run without a query mix, so existing assessments keep today\'s behaviour', () => {
    const blank = input({ queryMixExactPercent: null, queryMixMultiHopPercent: null, queryMixSemanticPercent: null, queryMixAnalyticsPercent: null, queryMixRelationshipPercent: null });
    expect(hasRetrievalStrategyInputs(blank)).toBe(false);
    expect(evaluateRetrievalStrategy(blank, cfg)).toBeNull();
    expect(evaluateRetrievalStrategy(input({ queryMixExactPercent: 0, queryMixMultiHopPercent: 0, queryMixSemanticPercent: 0, queryMixAnalyticsPercent: 0, queryMixRelationshipPercent: 0 }), cfg)).toBeNull();
    expect(evaluateRetrievalStrategy(input(), undefined as any)).toBeNull();
  });

  it('recommends going vectorless for a bounded corpus of long, structured documents with multi-hop questions', () => {
    const rs = evaluateRetrievalStrategy(input(), cfg)!;
    expect(rs.recommendedFamily).toBe('vectorless');
    expect(rs.vectorDatabaseRequired).toBe(false);
    expect(rs.recommendedApproach).toBe('reasoning_navigation');
    expect(rs.headline).toMatch(/^No dedicated vector database needed/);
    // 300 documents: navigate after a cheap document pre-filter
    expect(rs.rationale).toContain('pre-filter');
    expect(rs.rationale).toContain('fallback');
    expect(rs.referenceArchitecture.map((l) => l.layer)).toEqual(['Ingest', 'Index', 'Navigate', 'Answer', 'Govern']);
  });

  it('keeps a vector database for short, semantic-heavy content that needs fast answers at load', () => {
    const rs = evaluateRetrievalStrategy(input(vectorWorkload), cfg)!;
    expect(rs.vectorDatabaseRequired).toBe(true);
    expect(['vector_rag', 'hybrid']).toContain(rs.recommendedApproach);
    expect(rs.factors.find((f) => f.factor === 'Document structure')!.leansTo).toBe('vector');
  });

  it('gates long-context out when the corpus is larger than the context window', () => {
    const rs = evaluateRetrievalStrategy(input(), cfg)!; // 300 x 120 KB x 256 tokens/KB = 9.2M tokens
    expect(rs.corpusTokens).toBe(300 * 120 * cfg.tokensPerKb);
    const longContext = rs.approaches.find((a) => a.approach === 'long_context')!;
    expect(longContext.gate?.factor).toBe(cfg.gates.contextWindowExceededFactor);
    expect(longContext.gate?.reason).toContain('context window');
  });

  it('lets long-context win when the whole corpus fits comfortably in the context window', () => {
    const rs = evaluateRetrievalStrategy(input({ documentCount: 8, avgDocumentSizeKb: 40 }), cfg)!; // ~82K tokens
    const longContext = rs.approaches.find((a) => a.approach === 'long_context')!;
    expect(longContext.gate).toBeNull();
    expect(rs.recommendedFamily).toBe('vectorless');
  });

  it('gates LLM-in-the-loop retrieval out for a sub-300 ms latency target', () => {
    const rs = evaluateRetrievalStrategy(input({ targetP95LatencyMs: 120 }), cfg)!;
    expect(rs.approaches.find((a) => a.approach === 'reasoning_navigation')!.gate?.factor).toBe(cfg.gates.realtimeLatencyFactor);
    expect(rs.approaches.find((a) => a.approach === 'long_context')!.gate).not.toBeNull();
    expect(rs.recommendedApproach).not.toBe('reasoning_navigation');
  });

  it('gates lexical search out for multi-modal content', () => {
    const rs = evaluateRetrievalStrategy(input({ contentModality: ContentModality.MULTIMODAL }), cfg)!;
    expect(rs.approaches.find((a) => a.approach === 'lexical')!.gate?.reason).toContain('images');
  });

  it('routes analytics and relationship questions to structured paths when their share is large', () => {
    const rs = evaluateRetrievalStrategy(input({ queryMixAnalyticsPercent: 25, queryMixRelationshipPercent: 20 }), cfg)!;
    expect(rs.additionalRoutes).toEqual(['a text-to-SQL route for analytics questions', 'a knowledge-graph route for relationship questions']);
    expect(evaluateRetrievalStrategy(input(), cfg)!.additionalRoutes).toEqual([]);
  });

  it('normalises a query mix that does not add up to 100', () => {
    const rs = evaluateRetrievalStrategy(input({ queryMixExactPercent: 2, queryMixMultiHopPercent: 2, queryMixSemanticPercent: 0, queryMixAnalyticsPercent: 0, queryMixRelationshipPercent: 0 }), cfg)!;
    expect(rs.normalizedQueryMix.exact).toBeCloseTo(0.5);
    expect(rs.normalizedQueryMix.multiHop).toBeCloseTo(0.5);
  });

  it('prices each approach from the cost model - embedding build, cached long-context, rerank', () => {
    const rs = evaluateRetrievalStrategy(input(), cfg)!;
    const get = (id: string) => rs.approaches.find((a) => a.approach === id)!;
    const m = cfg.costModel;
    expect(get('vector_rag').oneTimeBuildCostUsd).toBeCloseTo((rs.corpusTokens * m.embeddingPerMillionTokens) / 1e6, 3);
    expect(get('lexical').oneTimeBuildCostUsd).toBe(0);
    expect(get('hybrid').costPerQueryUsd).toBeGreaterThan(get('vector_rag').costPerQueryUsd); // reranker
    expect(get('reasoning_navigation').costPerQueryUsd).toBeGreaterThan(get('lexical').costPerQueryUsd); // navigation calls
    for (const a of rs.approaches) {
      expect(a.monthlyRunCostUsd).toBeGreaterThanOrEqual(0);
      expect(a.estimatedLatencySeconds).toBeGreaterThan(0);
    }
  });

  it('flags a close call and sizes the golden set by explainability need', () => {
    const regulated = evaluateRetrievalStrategy(input({ explainabilityNeed: ExplainabilityNeed.REGULATED }), cfg)!;
    expect(regulated.evaluationPlan[0]).toContain('golden set of 200');
    expect(evaluateRetrievalStrategy(input({ explainabilityNeed: ExplainabilityNeed.STANDARD }), cfg)!.evaluationPlan[0]).toContain('golden set of 50');
    const rs = evaluateRetrievalStrategy(input(), cfg)!;
    expect(rs.closeCall).toBe(rs.approaches[0].score - rs.approaches[1].score < cfg.closeCallPoints);
  });

  it('records blank optional inputs as assumptions instead of hiding them', () => {
    const rs = evaluateRetrievalStrategy(input({ documentStructure: null, explainabilityNeed: undefined }), cfg)!;
    expect(rs.factors.find((f) => f.factor === 'Document structure')!.input).toContain('not given - assumed');
    expect(rs.factors.find((f) => f.factor === 'Explainability')!.input).toContain('not given - assumed');
  });

  it('is deterministic', () => {
    expect(evaluateRetrievalStrategy(input(), cfg)).toEqual(evaluateRetrievalStrategy(input(), cfg));
  });
});

describe('Recommendation Engine with the Retrieval Strategy Assessment', () => {
  const engine = new RecommendationEngineService(config);

  it('keeps the platform ranking and marks it as the fallback when vectorless wins', () => {
    const result = engine.evaluate(input({ containsPii: true, regulatoryRequirements: 'GDPR' }));
    const rs = result.retrievalStrategy!;
    expect(rs.vectorDatabaseRequired).toBe(false);
    expect(Object.values(VectorPlatform)).toContain(result.decision); // Phases 2-7 still get a platform
    expect(result.rationale).toMatch(/^Retrieval strategy: No dedicated vector database needed/);
    expect(result.rationale).toContain('fallback platform');
    expect(result.plainLanguageSummary.headline).toContain('fallback');
    expect(result.openValidations.some((v) => v.startsWith('Retrieval strategy: confirm'))).toBe(true);
    const riskIds = result.risks.map((r) => r.id);
    expect(riskIds).toEqual(expect.arrayContaining(['risk-vectorless-llm-dependency', 'risk-vectorless-data-to-llm']));
    expect(result.assumptions.map((a) => a.id)).toEqual(expect.arrayContaining(['assumption-retrieval-corpus-tokens', 'assumption-retrieval-cost-directional']));
  });

  it('adds an exact-term risk when a vector database is required but many questions use exact terms', () => {
    const result = engine.evaluate(input({ ...vectorWorkload, queryMixExactPercent: 40, queryMixSemanticPercent: 55 }));
    expect(result.retrievalStrategy!.vectorDatabaseRequired).toBe(true);
    expect(result.risks.map((r) => r.id)).toContain('risk-vector-exact-terms');
    expect(result.rationale).not.toMatch(/^Retrieval strategy/);
  });

  it('leaves the result exactly as before when the assessment has no query mix', () => {
    const blank = input({ queryMixExactPercent: null, queryMixMultiHopPercent: null, queryMixSemanticPercent: null, queryMixAnalyticsPercent: null, queryMixRelationshipPercent: null });
    const result = engine.evaluate(blank);
    expect(result.retrievalStrategy).toBeNull();
    expect(result.rationale).not.toContain('Retrieval strategy');
    expect(result.openValidations.some((v) => v.startsWith('Retrieval strategy'))).toBe(false);
    expect(result.risks.some((r) => r.id.startsWith('risk-vectorless') || r.id.startsWith('risk-retrieval'))).toBe(false);
    expect(result.assumptions.some((a) => a.id.startsWith('assumption-retrieval'))).toBe(false);
  });
});
