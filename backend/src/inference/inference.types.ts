/**
 * Inference Assessment - shared types. Deliberately independent
 * of the vector-database phase types: this track sizes model serving, not
 * retrieval, and only reads (never writes) vector-track data for defaults.
 */

export enum InferenceWorkloadType {
  CHAT = 'chat',
  RAG = 'rag',
  SUMMARIZATION = 'summarization',
  AGENT = 'agent',
  CODE = 'code',
  CLASSIFICATION = 'classification',
  BATCH = 'batch',
}

export enum ModelSourcing {
  SELF_HOSTED = 'self_hosted',
  MANAGED_API = 'managed_api',
  EVALUATE_BOTH = 'evaluate_both',
}

export enum GpuPricingModel {
  ON_DEMAND = 'on_demand',
  RESERVED_1YR = 'reserved_1yr',
  SPOT = 'spot',
}

export enum InferenceOpsCapability {
  NONE = 'none',
  PART_TIME = 'part_time',
  DEDICATED_TEAM = 'dedicated_team',
  PLATFORM_TEAM = 'platform_team',
}

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
  bytesPerParam: number;
  kvBytes: number;
  requiresFp8Hardware: boolean;
  computeUsesFp8: boolean;
  qualityNote: string;
}

export interface ManagedApiTier {
  id: string;
  label: string;
  inputPer1M: number;
  outputPer1M: number;
}

/** Fully resolved inputs the engine runs on (defaults and overrides already applied). */
export interface InferenceEngineInput {
  workloadType: InferenceWorkloadType;
  modelSourcing: ModelSourcing;
  model: ModelSpec;
  precision: string; // 'auto' or a precision id
  managedApiTier: ManagedApiTier; // prices already overridden if the customer supplied contracted ones
  requestsPerDay: number;
  peakToAverageRatio: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  maxContextTokens: number;
  ttftTargetMs: number;
  tpotTargetMs: number;
  availabilityTargetPercent: number;
  gpuPricing: GpuPricingModel;
  allowedGpuIds?: string[];
  autoscaling: boolean;
  allowThirdPartyApi: boolean;
  containsPii: boolean;
  dataResidencyRequirement?: string;
  monthlyBudgetUsd?: number;
  monthlyGrowthPercent: number;
  opsCapability: InferenceOpsCapability;
}

export interface DemandProfile {
  requestsPerDay: number;
  avgRps: number;
  peakRps: number;
  tokensPerDay: number;
  tokensPerMonth: number;
  requestsPerMonth: number;
  peakOutputTokensPerSec: number;
  peakPrefillTokensPerSec: number;
}

export interface ModelFootprint {
  weightsGb: number;
  kvBytesPerToken: number;
  kvGbPerAvgSequence: number;
  kvGbPerMaxContextSequence: number;
}

export interface GpuOption {
  gpuId: string;
  gpuLabel: string;
  precision: string;
  tensorParallel: number;
  footprint: ModelFootprint;
  kvCapacityGb: number;
  maxBatchByMemory: number;
  maxBatchByTpot: number;
  batchSize: number;
  ttftMs: number;
  tpotMs: number;
  e2eLatencyMs: number;
  replicaCapacityRps: number;
  replicasAtPeak: number;
  replicasAtAverage: number;
  minReplicas: number;
  totalGpusAtPeak: number;
  gpuHourlyUsd: number;
  monthlyGpuCostPeakUsd: number;
  monthlyGpuCostAutoscaledUsd: number;
  monthlyTotalUsd: number;
  costPerMillionTokensUsd: number;
  costPerRequestUsd: number;
  meetsTtft: boolean;
  meetsTpot: boolean;
  notes: string[];
}

export interface ManagedApiCost {
  tierId: string;
  tierLabel: string;
  inputPer1M: number;
  outputPer1M: number;
  monthlyUsd: number;
  costPerRequestUsd: number;
  costPerMillionTokensUsd: number;
  excluded: boolean;
  exclusionReason?: string;
}

export interface BreakEvenPoint {
  requestsPerDay: number;
  managedApiMonthlyUsd: number;
  selfHostedMonthlyUsd: number | null;
}

export interface BreakEvenAnalysis {
  breakEvenRequestsPerDay: number | null;
  note: string;
  curve: BreakEvenPoint[];
}

export interface InferenceForecastPoint {
  horizonMonths: number;
  requestsPerDay: number;
  selfHostedMonthlyUsd: number | null;
  selfHostedGpuId: string | null;
  selfHostedTotalGpus: number | null;
  managedApiMonthlyUsd: number;
}

export interface CalculationStep {
  step: string;
  formula: string;
  result: string;
}

export interface InferenceAssessmentResult {
  rulesVersion: string;
  demand: DemandProfile;
  gpuOptions: GpuOption[];
  recommendedGpuOption: GpuOption | null;
  managedApi: ManagedApiCost;
  decision: InferenceDecision;
  decisionRationale: string[];
  breakEven: BreakEvenAnalysis;
  forecast: InferenceForecastPoint[];
  workings: CalculationStep[];
  risks: string[];
  assumptions: string[];
}

/** Read-only suggestions derived from this project's vector-DB track, if any. */
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
  ttftTargetMs?: number;
  allowThirdPartyApi?: boolean;
  /** From Model Selection (AI Factory Wave 3), when one exists - suggestions only. */
  modelId?: string;
  managedApiTierId?: string;
  modelSourcing?: ModelSourcing;
}
