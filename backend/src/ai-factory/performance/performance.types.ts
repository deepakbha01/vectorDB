import { EvidenceType } from '../ai-factory.types';

export type MetricStatus = 'pass' | 'pass_with_conditions' | 'fail' | 'requires_benchmark' | 'not_applicable';
export type MetricGroup = 'vector' | 'embedding' | 'llm' | 'infrastructure';

export interface MetricDefinition {
  id: string;
  label: string;
  unit: string;
  direction: 'higher' | 'lower';
  measurable: boolean;
  how: string;
}

export interface PerformanceCatalogue {
  rulesVersion: string;
  statusLabels: Record<MetricStatus, string>;
  conditionalMarginPercent: number;
  sampleCheck: { minShare: number; minSampleVectors: number; minIngestionDocuments: number };
  assumedTargets: {
    qualityByAccuracy: Record<'standard' | 'high' | 'critical', number>;
    gpuUtilizationMaxPercent: number;
    gpuMemoryMaxPercent: number;
    cpuUtilizationMaxPercent: number;
    ramUtilizationMaxPercent: number;
    networkRoundTripMaxMs: number;
    initialLoadHours: number;
  };
  networkEstimateMs: Record<'single_target' | 'hybrid', number>;
  groups: Array<{ id: MetricGroup; label: string; metrics: MetricDefinition[] }>;
}

export interface TargetValue {
  value: number;
  source: string;
  assumed: boolean;
}

export interface EstimateValue {
  value: number;
  evidenceType: Exclude<EvidenceType, 'measured'>;
  source: string;
}

export interface MeasuredValue {
  value: number;
  source: string;
  measuredAt: string | null;
  /** true when an architect recorded it; false when the platform measured it (benchmark / ingestion run). */
  reported: boolean;
  /** Conditions on the measurement itself (small sample, measured before a design change). */
  caveats: string[];
}

/** One metric's inputs, resolved from the upstream records. */
export interface MetricInputs {
  applicable: boolean;
  notApplicableReason?: string;
  target: TargetValue | null;
  estimate: EstimateValue | null;
  measured: MeasuredValue | null;
}

export interface PerformanceContext {
  metrics: Record<string, MetricInputs>;
  /** Upstream records that do not exist yet. */
  missingInputs: string[];
}

export interface MetricResult extends MetricDefinition {
  group: MetricGroup;
  target: TargetValue | null;
  estimate: EstimateValue | null;
  measured: MeasuredValue | null;
  status: MetricStatus;
  reasons: string[];
  conditions: string[];
  /** Whether the estimate alone would meet the target - an early warning, never a PASS. */
  estimateMeetsTarget: boolean | null;
}

export interface PerformanceResult {
  rulesVersion: string;
  status: { status: Exclude<MetricStatus, 'not_applicable'>; label: string; reasons: string[] };
  counts: Record<MetricStatus, number>;
  groups: Array<{ id: MetricGroup; label: string; metrics: MetricResult[] }>;
  benchmarkPlan: Array<{ metric: string; how: string; warning: string | null }>;
  gaps: string[];
}
