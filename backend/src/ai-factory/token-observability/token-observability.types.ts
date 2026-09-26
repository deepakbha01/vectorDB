import { EvidenceType } from '../ai-factory.types';

/**
 * Token Observability (AI Factory Wave 12) - shared types.
 *
 * Estimated usage is the phase's versioned deliverable (ai_token_estimates).
 * Simulated and live usage arrive later as normalized usage events; the three
 * are never mixed in one figure.
 */

/** Spec §12: where a number came from. */
export type TelemetryMode = 'estimated' | 'simulated' | 'live';

/** Whether any observed usage exists for the project. */
export type TelemetryStatus = 'no_telemetry' | 'simulated_only' | 'receiving' | 'stale';

export interface TokenLine {
  label: string;
  tokens: number;
  evidenceType: EvidenceType;
  source: string;
}

export interface CostLine {
  item: string;
  tokens: number;
  pricePer1M: number | null;
  usd: number | null;
  /** Which price row was used (provider / model / token type @ effective date), or why none applied. */
  price: string;
  evidenceType: EvidenceType;
}

export interface TokenEstimateResult {
  rulesVersion: string;
  mode: 'estimated';
  scope: { rag: boolean; agent: boolean; summary: string };
  /** One user request, end to end (all LLM calls in it). */
  perRequest: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextTokens: number;
    embeddingTokens: number;
    rerankingTokens: number;
    retrievedChunks: number;
    llmCalls: number;
    toolCalls: number;
    /** What makes up the input of the final LLM call. */
    input: TokenLine[];
  };
  /** Spec §8. Null when the solution has no retrieval. */
  rag: {
    queryTokens: number;
    queryEmbeddingTokens: number;
    retrievalCount: number;
    retrievedContextTokens: number;
    rerankingTokens: number;
    historyTokens: number;
    systemPromptTokens: number;
    finalInputTokens: number;
    outputTokens: number;
    /** Retrieved context tokens / original query tokens. */
    contextExpansionRatio: number;
  } | null;
  /** Spec §9. Null when the solution has no agent. */
  agent: {
    pattern: string;
    llmCallsPerTask: number;
    toolCallsPerTask: number;
    tokensPerTask: number;
    steps: Array<{ step: string; inputTokens: number; outputTokens: number }>;
    costPerTaskUsd: number | null;
    loopGuard: string;
  } | null;
  monthly: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    embeddingTokens: number;
    rerankingTokens: number;
    basis: string;
  };
  cost: {
    currency: string;
    lines: CostLine[];
    monthlyUsd: number | null;
    perRequestUsd: number | null;
    note: string;
  };
  budget: { monthlyBudgetUsd: number | null; shareOfBudget: number | null; source: string | null };
  assumptions: string[];
  gaps: string[];
  wouldChangeIf: string[];
  /** Every estimation input with its provenance (absent on estimates saved before inputs existed). */
  inputs?: ResolvedInput[];
  /** Daily view of the monthly projection. */
  daily?: { requests: number; totalTokens: number; operatingDaysPerMonth: number };
  /** LLM usage mode and the share of requests that call the LLM. */
  llm?: { usage: LlmUsage; requestSharePercent: number; llmRequestsPerMonth: number; retryRatePercent: number; cacheHitRatePercent: number };
}

/** Spec §16: the tokenObservability section of the central assessment state. */
export interface TokenObservabilityState {
  mode: TelemetryMode;
  expectedTokensPerRequest: number | null;
  expectedMonthlyTokens: number | null;
  observedInputTokens: number | null;
  observedOutputTokens: number | null;
  observedTotalTokens: number | null;
  embeddingTokens: number | null;
  contextTokens: number | null;
  llmCallsPerRequest: number | null;
  estimatedCost: number | null;
  actualCost: number | null;
  topConsumers: Array<{ dimension: string; key: string; totalTokens: number }>;
  alerts: number;
  telemetryStatus: TelemetryStatus;
  // Beyond the spec §16 shape, for the readiness gate (Final Recommendation).
  estimateVersion: number | null;
  estimatedShareOfBudget: number | null;
  criticalAlerts: number;
}

/** config/token-observability.yaml */
export interface TokenObservabilityCatalogue {
  rulesVersion: string;
  pricing: import('./pricing').PricingTreatment;
  estimation: { toolCallOutputTokens: number; agentStepsShareOfMax: number; operatingDaysPerMonth?: number };
  observed: { loopLlmCallsPerTrace: number; liveStaleAfterHours: number };
  otel: { span: Record<string, string[]>; resource: Record<string, string[]> };
  alerts: import('./alerts').AlertCatalogue;
}

/**
 * Everything the estimate is built from, resolved from the upstream phases
 * (see `sources`). The engine is pure: this, the price rows and a moment.
 */
export interface EstimateContext {
  scope: { rag: boolean; agent: boolean; source: string };
  requestsPerMonth: number;
  requestsSource: string | null;
  queryTokens: number;
  /** Final-answer tokens and, without a RAG / agent design, the whole prompt size. */
  llm: {
    avgInputTokens: number;
    avgOutputTokens: number;
    provider: string;
    model: string;
    label: string;
    /** Set when serving is self-hosted: capacity cost, not a token price. */
    selfHosted: { monthlyUsd: number; label: string } | null;
    /** Prices the Inference assessment ran with, to flag a gap with the price table. */
    assessedPrices: { inputPer1M: number; outputPer1M: number } | null;
    source: string;
  } | null;
  /** From the RAG / agent design; null means no design yet (prompt taken whole from Inference). */
  design: {
    systemPromptTokens: number;
    historyTokens: number;
    topK: number;
    chunkTokens: number;
    chunkAssumed: boolean;
    rerank: { id: string; label: string; candidates: number } | null;
    agent: { id: string; label: string; maxSteps: number; toolSchemaTokens: number; toolResultPerStep: number } | null;
    /** A user override of the retrieved-context size, replacing top-K × chunk size. */
    retrievedContextTokens?: number;
    source: string;
  } | null;
  embedding: { provider: string; model: string; monthlyNewDocumentTokens: number; source: string } | null;
  budget: { monthlyUsd: number; source: string } | null;
  gaps: string[];
  /** Estimation settings (validation spec §3). Absent = the defaults below. */
  knobs?: EstimateKnobs;
}

/** How requests turn into LLM usage. Defaults keep the original behaviour. */
export interface EstimateKnobs {
  /** required (default) / optional (only a share of requests call the LLM) / none (vector-only). */
  llmUsage: LlmUsage;
  /** Share of requests that call the LLM, 0-100 (default 100). */
  llmRequestSharePercent: number;
  /** LLM calls in a non-agent request, e.g. a chain (default 1). */
  llmCallsPerRequest: number;
  /** Extra LLM traffic from retries, percent (default 0). */
  retryRatePercent: number;
  /** Share of input tokens served from the provider cache, percent (default 0) - changes cost, not tokens. */
  cacheHitRatePercent: number;
  /** Days a month the workload runs (default 30.4). */
  operatingDaysPerMonth: number;
  /** Overrides of the per-request embedding and reranking tokens. */
  embeddingTokensPerRequest?: number;
  rerankingTokensPerRequest?: number;
}

export type LlmUsage = 'required' | 'optional' | 'none';

/** Where an estimation input came from (validation spec §1, §17). */
export type InputProvenance = 'user_override' | 'calculated' | 'pattern_default' | 'not_configured';

export interface ResolvedInput {
  key: string;
  label: string;
  unit: string;
  value: number | string | null;
  provenance: InputProvenance;
  /** Which phase, pattern or setting supplied it. */
  source: string;
}
