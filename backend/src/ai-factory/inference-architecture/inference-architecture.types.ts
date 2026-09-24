import { Eligibility, EvidenceType } from '../ai-factory.types';

export type InferencePattern = 'synchronous' | 'streaming' | 'asynchronous' | 'batch' | 'real_time';
export type ModelFamily = 'open_weight' | 'proprietary_api';

export interface ServingOption {
  id: string;
  label: string;
  runtime: string;
  modelFamilies: ModelFamily[];
  runsOn: string[];
  requiresKubernetes: boolean;
  requiresGpu: boolean;
  patterns: InferencePattern[];
  precisions: string[];
  multiGpuTensorParallel: boolean;
  maxModelParamsB?: number;
  features: string[];
  gpuVendors: string[];
  opsComplexity: number;
  performanceTier: number;
  maturityTier: number;
  costTier: number;
  licence: string;
  note?: string;
}

export interface ServingCatalogue {
  rulesVersion: string;
  servingOptions: ServingOption[];
  opsCapacity: Record<string, number>;
  scoringWeights: Record<'performance' | 'operationalSimplicity' | 'maturity' | 'cost' | 'featureFit', number>;
  desiredFeatures: Record<string, string[]>;
  latencyTailFactors: { p50: number; p95: number; p99: number };
  autoscalingSignals: Record<InferencePattern, string>;
}

export interface RouteModel {
  label: string;
  family: ModelFamily;
}

/** Everything the architecture is designed from, resolved from the latest deliverables. */
export interface ServingContext {
  inferenceVersion: number;
  inferenceDecision: 'self_hosted' | 'managed_api' | 'either' | 'none_feasible';
  allowedFamilies: ModelFamily[];
  modelLabel: string;
  modelParamsB: number | null;
  apiTierLabel: string | null;
  precision: string | null;
  tensorParallel: number;
  gpuLabel: string | null;
  totalGpusAtPeak: number | null;
  replicas: { min: number; average: number; peak: number } | null;
  ttftMs: number | null;
  tpotMs: number | null;
  e2eMs: number | null;
  ttftTargetMs: number;
  tpotTargetMs: number;
  availabilityTargetPercent: number;
  peakRps: number;
  monthlyCostUsd: number | null;
  patterns: InferencePattern[];
  deploymentTargets: string[];
  hasKubernetes: boolean | null;
  hasGpu: boolean | null;
  opsCapability: string;
  needsMultiLora: boolean;
  restrictedData: boolean;
  containsPii: boolean;
  dataResidency: string | null;
  multiTenant: boolean;
  securityControls: string[];
  routing: { primary: RouteModel | null; secondary: RouteModel | null; fallback: RouteModel | null } | null;
}

export interface EvaluatedServingOption {
  id: string;
  label: string;
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  score: number;
  criteria: Record<string, number>;
}

export interface RouteRule {
  when: string;
  routeTo: string;
  why: string;
}

export interface LatencyEstimate {
  metric: string;
  p50: number;
  p95: number;
  p99: number;
  targetMs: number | null;
  /** The P95 estimate against the target; null when there is no target. */
  meetsTargetAtP95: boolean | null;
}

/** Spec §8 deliverable: the Inference Architecture Decision Record. */
export interface InferenceArchitectureResult {
  rulesVersion: string;
  recommended: EvaluatedServingOption | null;
  candidates: EvaluatedServingOption[];
  confidence: 'high' | 'medium' | 'low';
  why: string[];
  wouldChangeIf: string[];
  architecture: {
    layers: Array<{ layer: string; component: string; detail: string }>;
    inferenceApi: string[];
    gateway: string[];
    policy: string[];
    routes: RouteRule[];
    runtime: string[];
    compute: string[];
    replicaStrategy: string[];
    autoscaling: string[];
    loadBalancing: string[];
    fallback: string[];
    sla: { targets: string[]; latency: LatencyEstimate[] };
    observability: string[];
    security: string[];
    cost: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  } | null;
  benchmarkRequired: string[];
}
