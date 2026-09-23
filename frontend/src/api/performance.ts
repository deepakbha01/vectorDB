/** Performance & Benchmark (AI Factory Wave 8) - mirrors backend/src/ai-factory/performance/*. */
import { EvidenceType } from './aiFactory';

export type MetricStatus = 'pass' | 'pass_with_conditions' | 'fail' | 'requires_benchmark' | 'not_applicable';

export interface Measurement {
  metric: string;
  value: number;
  source: string;
  measuredAt?: string;
}

export interface CreatePerformanceAssessmentInput {
  measurements?: Measurement[];
}

export interface MetricResult {
  id: string;
  label: string;
  unit: string;
  direction: 'higher' | 'lower';
  how: string;
  group: string;
  target: { value: number; source: string; assumed: boolean } | null;
  estimate: { value: number; evidenceType: Exclude<EvidenceType, 'measured'>; source: string } | null;
  measured: { value: number; source: string; measuredAt: string | null; reported: boolean; caveats: string[] } | null;
  status: MetricStatus;
  reasons: string[];
  conditions: string[];
  estimateMeetsTarget: boolean | null;
}

export interface PerformanceResult {
  rulesVersion: string;
  status: { status: Exclude<MetricStatus, 'not_applicable'>; label: string; reasons: string[] };
  counts: Record<MetricStatus, number>;
  groups: Array<{ id: string; label: string; metrics: MetricResult[] }>;
  benchmarkPlan: Array<{ metric: string; how: string; warning: string | null }>;
  gaps: string[];
}

export interface PerformanceAssessment {
  id: string;
  version: number;
  submitted: CreatePerformanceAssessmentInput;
  result: PerformanceResult;
  createdAt: string;
}

export interface PerformanceDefaults {
  preview: PerformanceResult;
}
