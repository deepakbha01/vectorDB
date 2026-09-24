/**
 * Inference-as-a-Service assessment - API types. Mirrors
 * backend/src/inference/inference.types.ts and the create DTO.
 */

export type InferenceWorkloadType = 'chat' | 'rag' | 'summarization' | 'agent' | 'code' | 'classification' | 'batch';
export type ModelSourcing = 'self_hosted' | 'managed_api' | 'evaluate_both';
export type GpuPricingModel = 'on_demand' | 'reserved_1yr' | 'spot';
export type InferenceOpsCapability = 'none' | 'part_time' | 'dedicated_team' | 'platform_team';
export type InferenceDecision = 'self_hosted' | 'managed_api' | 'either' | 'none_feasible';

export interface GpuSpec {
  id: string;
  label: string;
  memoryGb: number;
  bandwidthGbps: number;
  fp16Tflops: number;
  fp8Tflops?: number;
  hourlyUsd: number;
  interconnect?: 'nvlink' | 'pcie';
}

export interface ModelSpec {
  id: string;
  label: string;
  paramsB: number;
  activeParamsB: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  maxContextTokens: number;
  licence: string;
}

export interface PrecisionSpec {
  id: string;
  label: string;
  qualityNote: string;
}

export interface ManagedApiTier {
  id: string;
  label: string;
  inputPer1M: number;
  outputPer1M: number;
}

export interface InferenceCatalogue {
  rulesVersion: string;
  gpus: GpuSpec[];
  models: ModelSpec[];
  precisions: PrecisionSpec[];
  autoPrecisions: string[];
  managedApiTiers: ManagedApiTier[];
}

export interface CreateInferenceAssessmentInput {
  workloadType: InferenceWorkloadType;
  modelSourcing: ModelSourcing;
  requestsPerDay: number;
  peakToAverageRatio: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  maxContextTokens: number;
  monthlyGrowthPercent?: number;
  ttftTargetMs: number;
  tpotTargetMs: number;
  availabilityTargetPercent: number;
  modelId: string;
  precision?: string;
  customModelName?: string;
  customParamsB?: number;
  customActiveParamsB?: number;
  customLayers?: number;
  customKvHeads?: number;
  customHeadDim?: number;
  customMaxContextTokens?: number;
  allowedGpuIds?: string[];
  gpuPricing?: GpuPricingModel;
  autoscaling?: boolean;
  opsCapability: InferenceOpsCapability;
  managedApiTierId: string;
  apiInputPricePer1M?: number;
  apiOutputPricePer1M?: number;
  allowThirdPartyApi: boolean;
  containsPii: boolean;
  dataResidencyRequirement?: string;
  monthlyBudgetUsd?: number;
}

export interface GpuOption {
  gpuId: string;
  gpuLabel: string;
  precision: string;
  tensorParallel: number;
  footprint: { weightsGb: number; kvBytesPerToken: number; kvGbPerAvgSequence: number; kvGbPerMaxContextSequence: number };
  kvCapacityGb: number;
  batchSize: number;
  ttftMs: number;
  tpotMs: number;
  e2eLatencyMs: number;
  replicaCapacityRps: number;
  replicasAtPeak: number;
  replicasAtAverage: number;
  totalGpusAtPeak: number;
  gpuHourlyUsd: number;
  monthlyTotalUsd: number;
  costPerMillionTokensUsd: number;
  costPerRequestUsd: number;
  meetsTtft: boolean;
  meetsTpot: boolean;
  notes: string[];
}

export interface InferenceAssessmentResult {
  rulesVersion: string;
  demand: {
    requestsPerDay: number;
    avgRps: number;
    peakRps: number;
    tokensPerMonth: number;
    requestsPerMonth: number;
    peakOutputTokensPerSec: number;
  };
  gpuOptions: GpuOption[];
  recommendedGpuOption: GpuOption | null;
  managedApi: {
    tierLabel: string;
    inputPer1M: number;
    outputPer1M: number;
    monthlyUsd: number;
    costPerRequestUsd: number;
    costPerMillionTokensUsd: number;
    excluded: boolean;
    exclusionReason?: string;
  };
  decision: InferenceDecision;
  decisionRationale: string[];
  breakEven: {
    breakEvenRequestsPerDay: number | null;
    note: string;
    curve: Array<{ requestsPerDay: number; managedApiMonthlyUsd: number; selfHostedMonthlyUsd: number | null }>;
  };
  forecast: Array<{
    horizonMonths: number;
    requestsPerDay: number;
    selfHostedMonthlyUsd: number | null;
    selfHostedGpuId: string | null;
    selfHostedTotalGpus: number | null;
    managedApiMonthlyUsd: number;
  }>;
  workings: Array<{ step: string; formula: string; result: string }>;
  risks: string[];
  assumptions: string[];
}

export interface InferenceAssessment {
  id: string;
  version: number;
  submitted: CreateInferenceAssessmentInput;
  decision: InferenceDecision;
  result: InferenceAssessmentResult;
  rulesVersion: string;
  createdAt: string;
}

export interface InferenceDefaultsSuggestion {
  source: string[];
  requestsPerDay?: number;
  peakToAverageRatio?: number;
  avgInputTokens?: number;
  ragContextTokens?: number;
  availabilityTargetPercent?: number;
  containsPii?: boolean;
  dataResidencyRequirement?: string;
  monthlyBudgetUsd?: number;
  workloadType?: InferenceWorkloadType;
  /** From the AI Workload Profile (AI Factory Wave 2), when one exists. */
  ttftTargetMs?: number;
  allowThirdPartyApi?: boolean;
  /** From Model Selection (AI Factory Wave 3), when one exists - suggestions only. */
  modelId?: string;
  managedApiTierId?: string;
  modelSourcing?: ModelSourcing;
}

export const DECISION_LABELS: Record<InferenceDecision, string> = {
  self_hosted: 'Self-host an open-weight model on GPUs',
  managed_api: 'Use a managed model API',
  either: 'Either - costs are comparable',
  none_feasible: 'No feasible option under these constraints',
};
