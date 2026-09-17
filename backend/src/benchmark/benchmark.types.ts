export interface VariantResult {
  searchParamName: string;
  searchParamValue: number;
  isBaseline: boolean;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgRecall: number;
  achievedQps: number;
}

export interface CapacityImpact {
  estimatedMemoryGb: number;
}

export interface CostImplications {
  estimatedCostPerHourUsd: number;
}
