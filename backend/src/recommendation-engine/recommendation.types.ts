import { VectorPlatform } from '../projects/enums/platform.enum';
import { OperationalCapability, TenancyModel } from '../discovery/enums/discovery.enum';
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

export interface ScoredOption {
  platformId: VectorPlatform;
  label: string;
  totalScore: number;
  criteriaScores: CriteriaScores;
  evidence: string[];
  /** False if this platform fails a hard search-capability requirement (see `ineligibleReasons`) and therefore cannot win, regardless of totalScore. */
  eligible: boolean;
  ineligibleReasons: string[];
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
  rejectedAlternatives: Array<{ platformId: VectorPlatform; reason: string }>;
  assumptions: string[];
  risks: string[];
  infrastructureEstimate: InfrastructureEstimate;
  operationalComplexity: string;
  plainLanguageSummary: PlainLanguageSummary;
}
