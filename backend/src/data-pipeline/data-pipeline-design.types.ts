import { SimilarityMetric } from '../discovery/enums/discovery.enum';
import { IndexRecommendationInput, IndexType } from '../index-recommendation-engine/index-recommendation.types';

export enum DimensionMismatchReason {
  MODEL_QUALITY_REQUIREMENT = 'model_quality_requirement',
  MODEL_MIGRATION = 'model_migration',
  BENCHMARK_RESULT = 'benchmark_result',
  CUSTOMER_REQUIREMENT = 'customer_requirement',
  OTHER = 'other',
}

export type Phase3HandoffStatus = 'READY' | 'READY_WITH_CONDITIONS' | 'BLOCKED';

/**
 * The formal Phase 2 -> Phase 3 contract (refactoring spec S9/S10): Phase 3
 * (Index Design) consumes this structured object instead of reading Discovery/
 * Data Pipeline Design fields ad hoc. Everything IndexRecommendationInput needs
 * EXCEPT `updateFrequency`, which is a genuine Phase-3-time architect choice,
 * not something Phase 2 can hand off - IndexDesignService merges it in from
 * the Phase 3 submit DTO to form the engine's actual input.
 */
export interface Phase2Handoff extends Omit<IndexRecommendationInput, 'updateFrequency'> {
  metric: SimilarityMetric;
  peakQps: number;
  /** Calculated (topK * 10, minimum 100), not customer-provided - no phase captures this explicitly today. */
  candidateK: number;
  filterUsage: boolean;
  hybridSearch: boolean;
  reranking: boolean;
  /** The full universe of index families the Phase 3 engine can choose among - not a recommendation. */
  candidateIndexFamilies: IndexType[];
  status: Phase3HandoffStatus;
  statusReasons: string[];
}
