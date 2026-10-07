import { VectorPlatform } from '../projects/enums/platform.enum';
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
import { FitRating, PlainLanguageScorecardRow } from '../common/plain-language.types';

export { FitRating, PlainLanguageScorecardRow } from '../common/plain-language.types';

/**
 * Decouples the engine from the Discovery module's DTO/entity so the engine
 * can be unit-tested and reused (e.g. by a future what-if simulator) without
 * depending on persistence types. Discovery module maps into this shape.
 */
export interface AssessmentInput {
  estimatedVectorCount: number;
  embeddingDimension: number;
  qps: number;
  peakQps: number;
  targetP95LatencyMs: number;
  targetP99LatencyMs: number;
  recallTarget: number;
  precisionTarget?: number | null;
  requiresReranking: boolean;
  hasExistingOracle: boolean;
  hasExistingPostgres: boolean;
  hasExistingKubernetes: boolean;
  /** Platforms (other than Oracle/PostgreSQL, which have their own dedicated flags above) already operated in production. */
  existingPlatforms: VectorPlatform[];
  containsPii: boolean;
  requiresHybridSearch: boolean;
  requiresFullTextSearch: boolean;
  requiresMetadataFiltering: boolean;
  operationalCapability: OperationalCapability;
  /** null when the Discovery assessment has no budget (the entity stores null). */
  monthlyBudgetUsd?: number | null;
  requiresMultiRegion: boolean;
  tenancyModel: TenancyModel;
  deploymentRegionCount?: number;
  trafficDistributionPercent?: string;
  dataReplicationModel: DataReplicationModel;
  regionalFailoverRequired: boolean;
  crossRegionReplicationRequired: boolean;
  qpsScope: QpsScope;
  requiresKeyManagement: boolean;
  requiresTenantIsolation: boolean;
  requiresAuditLogging: boolean;
  ndcgTarget?: number | null;
  mrrTarget?: number | null;
  // Only used by the PII compliance gate below - not otherwise scored by Phase 1.
  requiresEncryptionAtRest: boolean;
  requiresEncryptionInTransit: boolean;
  requiresAuthentication: boolean;
  requiresRbac: boolean;
  dataResidencyRequirement?: string;
  rpoMinutes: number;
  rtoMinutes: number;
  retentionDays: number;
  // ---- Retrieval Strategy Assessment inputs (all optional; see retrieval-strategy.ts) ----
  documentCount?: number;
  avgDocumentSizeKb?: number;
  regulatoryRequirements?: string | null;
  documentStructure?: DocumentStructure | null;
  contentModality?: ContentModality | null;
  contentChangeFrequency?: ContentChangeFrequency | null;
  explainabilityNeed?: ExplainabilityNeed | null;
  queryMixExactPercent?: number | null;
  queryMixMultiHopPercent?: number | null;
  queryMixSemanticPercent?: number | null;
  queryMixAnalyticsPercent?: number | null;
  queryMixRelationshipPercent?: number | null;
  isMultilingual?: boolean;
}

/** The five retrieval approaches the Retrieval Strategy Assessment compares. */
export type RetrievalApproachId = 'long_context' | 'reasoning_navigation' | 'lexical' | 'vector_rag' | 'hybrid';
/** Vectorless = no embeddings or vector index at all. */
export type RetrievalFamily = 'vectorless' | 'vector' | 'hybrid';

export interface RetrievalApproachScore {
  approach: RetrievalApproachId;
  label: string;
  family: RetrievalFamily;
  /** 0-100 fit score after any hard gate. */
  score: number;
  /** Set when a hard gate reduced the score (e.g. corpus larger than the context window). */
  gate: { factor: number; reason: string } | null;
  /** Directional cost and latency - list-price assumptions from thresholds.yaml. */
  costPerQueryUsd: number;
  monthlyRunCostUsd: number;
  oneTimeBuildCostUsd: number;
  estimatedLatencySeconds: number;
  /** Why this approach is (or is not) feasible against the latency target and load. */
  feasibilityNotes: string[];
}

export interface RetrievalFactor {
  factor: string;
  /** The project's input for this factor, in words. */
  input: string;
  weight: number;
  /** Which family this factor favours for this project. */
  leansTo: 'vectorless' | 'vector' | 'neutral';
}

/**
 * Result of the Retrieval Strategy Assessment. It sits beside the platform
 * ranking and never replaces it: when `vectorDatabaseRequired` is false the
 * platform decision is the fallback if the vectorless evaluation fails.
 */
export interface RetrievalStrategyResult {
  recommendedApproach: RetrievalApproachId;
  recommendedFamily: RetrievalFamily;
  /** false when a vectorless approach wins - no dedicated vector database is needed. */
  vectorDatabaseRequired: boolean;
  headline: string;
  rationale: string;
  /** Additional routes the query mix needs, e.g. text-to-SQL for analytics questions. */
  additionalRoutes: string[];
  /** True when the top two approaches are within `closeCallPoints` - decide by evaluation. */
  closeCall: boolean;
  approaches: RetrievalApproachScore[];
  factors: RetrievalFactor[];
  corpusTokens: number;
  normalizedQueryMix: { exact: number; multiHop: number; semantic: number; analytics: number; relationship: number };
  referenceArchitecture: Array<{ layer: string; detail: string }>;
  evaluationPlan: string[];
}

export interface CriteriaScores {
  vectorCount: number;
  qps: number;
  latency: number;
  recall: number;
  existingPlatform: number;
  operationalComplexity: number;
  cost: number;
}

/**
 * Three states, not two: `ineligible` fails a hard requirement and can never win.
 * `unverified` means a requirement was stated (e.g. multi-region) that this tool
 * does not model per-platform - it is not silently treated as satisfied, but it
 * also isn't a hard failure, so an `unverified` platform can still be the
 * (conditional) decision. Only `eligible` platforms are unconditionally clean.
 */
export type EligibilityStatus = 'eligible' | 'unverified' | 'ineligible';

/**
 * How a platform's cost-fit score was reached - the rule that applied, the
 * inputs it read and the arithmetic - so the score can be checked by hand.
 * The score is directional (relative cost of standing up and running the
 * platform), not a price; dollar figures come from the Cost Recommendation.
 */
export interface CostBreakdown {
  /** The 0-1 cost-fit score (the same number as criteriaScores.cost). */
  score: number;
  /** The cost model that applied, e.g. "Self-hosted on Kubernetes". */
  model: string;
  /** Why that model's starting point applies to this project. */
  basis: string;
  /** The terms added up, in order. */
  steps: Array<{ label: string; value: number }>;
  /** The calculation with this project's numbers, e.g. "min(1, 0.60 + 0.30 × 0.43) = 0.73". */
  formula: string;
  /** The cost criterion's weight in the total score. */
  weight: number;
  /** score × weight: what cost adds to the platform's total. */
  weightedContribution: number;
}

export interface ScoredOption {
  platformId: VectorPlatform;
  label: string;
  totalScore: number;
  criteriaScores: CriteriaScores;
  costBreakdown: CostBreakdown;
  evidence: string[];
  eligibilityStatus: EligibilityStatus;
  eligibilityNotes: string[];
}

export type AlternativeBucket = 'tied' | 'strong' | 'lower_fit' | 'capacity_constraint';

export interface RankedAlternative {
  platformId: VectorPlatform;
  reason: string;
  bucket: AlternativeBucket;
}

export type DecisionStatus = 'single' | 'tied' | 'conditional';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface BudgetFeasibility {
  monthlyBudgetUsd: number;
  status: 'within_budget' | 'exceeds_budget' | 'not_yet_estimated';
  estimatedMonthlyCostUsd: number | null;
  note: string;
}

export interface ComplianceCheck {
  control: string;
  satisfied: boolean;
}

export interface ComplianceGateResult {
  applicable: boolean;
  status: 'not_applicable' | 'passed' | 'unverified';
  checks: ComplianceCheck[];
}

export interface InfrastructureEstimate {
  estimatedRawVectorGb: number;
  estimatedMemoryGb: number;
  estimatedStorageGb: number;
  estimatedCpuCores: number;
  notes: string[];
}

/**
 * An executive-summary retelling of the ADR for readers who don't need to know
 * what "HNSW ef" or "criteria weights" mean - same underlying data, presented
 * in professional business language rather than the engine's technical terms.
 */
export interface PlainLanguageSummary {
  verdict: 'Excellent Fit' | 'Good Fit' | 'Workable Fit' | 'Weak Fit';
  /**
   * When set, this replaces `verdict` as the badge text - used when the raw score would
   * otherwise read "Excellent Fit" but an open validation (cost, multi-region, compliance)
   * or a weak individual criterion means that badge would overstate the actual fit.
   */
  conditionalBadge: string | null;
  headline: string;
  scorecard: PlainLanguageScorecardRow[];
  costAndEffort: string;
  risks: string[];
  bottomLine: string;
}

/** Structured Risk Register entry (spec S23) - never a plain string, so every risk carries category/impact/likelihood/mitigation/status. */
export type RiskCategory =
  | 'performance'
  | 'scalability'
  | 'security'
  | 'compliance'
  | 'availability'
  | 'cost'
  | 'migration'
  | 'data_quality'
  | 'search_quality'
  | 'vendor_platform'
  | 'operations';
export type RiskSeverity = 'low' | 'medium' | 'high';
export type RiskStatus = 'open' | 'mitigated' | 'accepted' | 'closed';

export interface RiskEntry {
  id: string;
  category: RiskCategory;
  description: string;
  impact: RiskSeverity;
  likelihood: RiskSeverity;
  mitigation: string;
  owner?: string;
  status: RiskStatus;
  validationRequired: boolean;
}

/** Structured Assumption Register entry (spec S24) - "mandatory" per spec; every calculated/derived value must show where it came from. */
export type AssumptionType = 'customer_provided' | 'architect_provided' | 'pattern_default' | 'calculated' | 'directional' | 'unknown';
export type AssumptionConfidence = 'high' | 'medium' | 'low';

export interface AssumptionEntry {
  id: string;
  parameter: string;
  value: string;
  source: string;
  type: AssumptionType;
  confidence: AssumptionConfidence;
  impact: string;
  validationRequired: boolean;
}

export interface RecommendationResult {
  rulesVersion: string;
  decision: VectorPlatform;
  rationale: string;
  options: ScoredOption[];
  rejectedAlternatives: RankedAlternative[];
  assumptions: AssumptionEntry[];
  risks: RiskEntry[];
  infrastructureEstimate: InfrastructureEstimate;
  operationalComplexity: string;
  plainLanguageSummary: PlainLanguageSummary;
  /** The scoring weights (from thresholds.yaml `scoringWeights`) actually used to compute `options[].totalScore`, so the report can show the real formula. */
  criteriaWeights: CriteriaScores;
  decisionStatus: DecisionStatus;
  confidence: ConfidenceLevel;
  /** All platforms within the tie epsilon of the top score, including the decision itself. Empty/single-element when there is no tie. */
  tiedPlatformIds: VectorPlatform[];
  /** Which tie-break stage selected `decision` from among `tiedPlatformIds`, or null when there was no tie to break. */
  tieBreakStage: string | null;
  /** Open items that should be resolved before treating `decision` as final (budget quote, multi-region model, compliance, etc.). */
  openValidations: string[];
  budgetFeasibility: BudgetFeasibility | null;
  complianceGate: ComplianceGateResult;
  /** "Does this need a vector database at all?" - null when the Discovery assessment has no query mix. */
  retrievalStrategy: RetrievalStrategyResult | null;
}

export interface SensitivityScenario {
  name: string;
  overrides: Partial<AssessmentInput>;
}

export interface SensitivityResult {
  scenario: string;
  decision: VectorPlatform;
  decisionChanged: boolean;
  totalScore: number;
  decisionStatus: DecisionStatus;
}
