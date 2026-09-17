import { UpdateFrequency } from './enums/update-frequency.enum';
import { IndexType } from './enums/index-type.enum';

export { IndexType };

export interface IndexRecommendationInput {
  vectorCount: number;
  dimension: number;
  availableMemoryGb: number;
  qps: number;
  recallTarget: number;
  targetP95LatencyMs: number;
  topK: number;
  updateFrequency: UpdateFrequency;
}

export interface IndexCriteriaScores {
  recall: number;
  latency: number;
  memory: number;
  throughput: number;
  updateFriendliness: number;
}

export interface ScoredIndexOption {
  indexType: IndexType;
  label: string;
  totalScore: number;
  criteriaScores: IndexCriteriaScores;
  estimatedMemoryGb: number;
  evidence: string[];
}

export interface TuningParameter {
  name: string;
  value: number;
  description: string;
}

export interface ImpactEstimate {
  recallEstimate: string;
  latencyEstimate: string;
  memoryEstimateGb: number;
}

export interface IndexRecommendationResult {
  rulesVersion: string;
  decision: IndexType;
  label: string;
  rationale: string;
  configuration: TuningParameter[];
  impact: ImpactEstimate;
  scalingConsiderations: string[];
  options: ScoredIndexOption[];
  alternatives: Array<{ indexType: IndexType; reason: string }>;
  /** The scoring weights (from thresholds.yaml `indexSelection.scoringWeights`) actually used to compute `options[].totalScore` above, so the report can show the real formula rather than a vague description. */
  criteriaWeights: IndexCriteriaScores;
}
