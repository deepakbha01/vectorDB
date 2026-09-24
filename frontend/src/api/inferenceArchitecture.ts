/** Inference Architecture (AI Factory Wave 4) - mirrors backend/src/ai-factory/inference-architecture/*. */
import { Eligibility, EvidenceType } from './aiFactory';

export type InferencePattern = 'synchronous' | 'streaming' | 'asynchronous' | 'batch' | 'real_time';
export const PATTERNS: Array<[InferencePattern, string]> = [
  ['synchronous', 'Synchronous'],
  ['streaming', 'Streaming'],
  ['asynchronous', 'Asynchronous'],
  ['batch', 'Batch'],
  ['real_time', 'Real-time'],
];

export interface CreateInferenceArchitectureInput {
  patterns?: InferencePattern[];
  hasKubernetes?: boolean;
  hasGpu?: boolean;
}

export interface EvaluatedServingOption {
  id: string;
  label: string;
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  score: number;
}

export interface LatencyEstimate {
  metric: string;
  p50: number;
  p95: number;
  p99: number;
  targetMs: number | null;
  meetsTargetAtP95: boolean | null;
}

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
    routes: Array<{ when: string; routeTo: string; why: string }>;
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

export interface InferenceArchitecture {
  id: string;
  version: number;
  submitted: CreateInferenceArchitectureInput;
  context: { patterns: InferencePattern[]; hasKubernetes: boolean | null; hasGpu: boolean | null };
  sources: Record<string, { source: string; detail: string }>;
  result: InferenceArchitectureResult;
  createdAt: string;
}

export interface InferenceArchitectureDefaults {
  context: { patterns: InferencePattern[]; hasKubernetes: boolean | null; hasGpu: boolean | null };
  sources: Record<string, { source: string; detail: string }>;
  preview: InferenceArchitectureResult;
}
