export interface VariantResult {
  searchParamName: string;
  searchParamValue: number;
  isBaseline: boolean;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgRecall: number;
  /** One client, one query at a time: about 1 / average latency. Not the system's throughput under load. */
  achievedQps: number;
  /**
   * Throughput with `concurrency` clients sending the same queries in parallel - the figure to
   * compare with a QPS target. Absent on reports saved before it was measured.
   */
  sustainedQps?: number;
  concurrency?: number;
}

export interface CapacityImpact {
  estimatedMemoryGb: number;
}

export interface CostImplications {
  estimatedCostPerHourUsd: number;
}
