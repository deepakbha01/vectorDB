import { VectorPlatform } from '../projects/enums/platform.enum';
import { DataReplicationModel, OperationalCapability, QpsScope, TenancyModel } from '../discovery/enums/discovery.enum';
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
  precisionTarget?: number;
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
  monthlyBudgetUsd?: number;
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
  ndcgTarget?: number;
  mrrTarget?: number;
  // Only used by the PII compliance gate below - not otherwise scored by Phase 1.
  requiresEncryptionAtRest: boolean;
  requiresEncryptionInTransit: boolean;
  requiresAuthentication: boolean;
  requiresRbac: boolean;
  dataResidencyRequirement?: string;
  rpoMinutes: number;
  rtoMinutes: number;
  retentionDays: number;
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

export interface ScoredOption {
  platformId: VectorPlatform;
  label: string;
  totalScore: number;
  criteriaScores: CriteriaScores;
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

export interface RecommendationResult {
  rulesVersion: string;
  decision: VectorPlatform;
  rationale: string;
  options: ScoredOption[];
  rejectedAlternatives: RankedAlternative[];
  assumptions: string[];
  risks: string[];
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
