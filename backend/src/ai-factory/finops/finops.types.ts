import { EvidenceType } from '../ai-factory.types';
import { PlatformKind, TargetId } from '../infrastructure/infrastructure.types';

export type CostCategory = 'inference' | 'vector_db' | 'embedding' | 'infrastructure' | 'operations';
export type CostResource = 'gpu' | 'cpu' | 'storage' | 'network' | 'api' | 'people' | 'other';

export interface TargetRates {
  vcpuHour: number;
  ramGbHour: number;
  blockStorageGbMonth: number;
  objectStorageGbMonth: number;
  egressGb: number;
  gpuFactor: number;
  supportPercent: number;
  monitoringPercent: number;
}

export interface FinopsCatalogue {
  rulesVersion: string;
  lastReviewed: string;
  currency: string;
  hoursPerMonth: number;
  targets: Record<TargetId, TargetRates>;
  platformPremium: Record<PlatformKind, number>;
  vectorReplicas: Array<{ minAvailability: number; replicas: number }>;
  application: { ramGbPerVcpu: number };
  embedding: { avgQueryTokens: number; selfHostedTokensPerSecPerGpu: number; selfHostedGpuId: string; reembedHorizonMonths: number };
  operations: { backupRetentionMultiplier: number; drFactor: Record<'cold' | 'warm' | 'active', number>; selfManagedDbOpsMonthlyUsd: number };
  network: { responseKbPerRequest: number; retrievalKbPerRequest: number; hybridInterconnectMonthlyUsd: number };
  budget: { withinMarginPercent: number };
}

/** Quantities resolved from the upstream records - what is being priced, not the prices. */
export interface FinopsContext {
  allowedTargets: TargetId[];
  inference: {
    mode: 'self_hosted' | 'managed_api';
    gpuId: string | null;
    gpuLabel: string | null;
    gpusAtPeak: number | null;
    /** GPU spend at the inference catalogue's list price (autoscaled if autoscaling is on). */
    gpuMonthlyListUsd: number;
    /** Serving overhead (storage, networking, load balancing, observability) as a share of GPU spend, and fixed platform engineering - config/inference.yaml. */
    overheadPercent: number;
    platformFixedMonthlyUsd: number;
    managedMonthlyUsd: number;
    managedTierLabel: string | null;
    requestsPerMonth: number;
    tokensPerMonth: number;
    weightsGb: number;
    source: string;
  } | null;
  vector: {
    platform: string;
    kinds: PlatformKind[];
    saasTargets: TargetId[] | null;
    cpuCores: number;
    memoryGb: number;
    storageGb: number;
    replicas: number;
    replicaReason: string;
    source: string;
  } | null;
  embedding: {
    model: string;
    selfHosted: boolean;
    pricePer1M: number;
    corpusTokens: number;
    monthlyNewTokens: number;
    monthlyQueryTokens: number;
    reembedTokens: number;
    source: string;
  } | null;
  application: { nodes: number; vcpusPerNode: number };
  modelVersionsKept: number;
  selfHostedEmbeddingGpuListHourly: number;
  requestsPerMonth: number;
  dr: { tier: 'cold' | 'warm' | 'active'; reason: string };
  /** Chosen placement per component (Infrastructure Design), if one exists. */
  placements: Partial<Record<'inference' | 'vector_database' | 'application', TargetId>> | null;
  deploymentKind: 'single_target' | 'hybrid' | 'not_feasible' | null;
  gpuAvailability: Record<TargetId, string[]>;
  monthlyBudgetUsd: number | null;
  budgetSource: string | null;
  missing: string[];
}

export interface CostLine {
  category: CostCategory;
  resource: CostResource;
  item: string;
  monthlyUsd: number;
  evidenceType: Exclude<EvidenceType, 'measured'>;
  basis: string;
}

export interface OneOffCost {
  item: string;
  usd: number;
  evidenceType: Exclude<EvidenceType, 'measured'>;
  basis: string;
}

export interface PricedOption {
  id: TargetId | 'hybrid' | 'chosen';
  label: string;
  targets: TargetId[];
  allowed: boolean;
  feasible: boolean;
  notFeasibleReasons: string[];
  monthlyUsd: number | null;
  byCategory: Record<CostCategory, number> | null;
  lines: CostLine[];
}

export interface FinopsResult {
  rulesVersion: string;
  ratesReviewed: string;
  disclaimer: string;
  chosen: PricedOption | null;
  comparison: PricedOption[];
  byResource: Record<CostResource, number> | null;
  unitEconomics: Array<{ label: string; usd: number; evidenceType: 'estimated'; basis: string }>;
  oneOff: OneOffCost[];
  budget: { monthlyBudgetUsd: number | null; source: string | null; status: 'within_budget' | 'near_budget' | 'exceeds_budget' | 'no_budget'; note: string };
  validation: { status: 'pass_with_conditions' | 'further_assessment' | 'fail'; reasons: string[] };
  cheapestAllowed: { id: string; label: string; monthlyUsd: number } | null;
  gaps: string[];
  wouldChangeIf: string[];
}
