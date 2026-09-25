/** Token Observability (AI Factory Wave 12) - mirrors backend/src/ai-factory/token-observability/*. */
import { EvidenceType } from './aiFactory';

export type TelemetryMode = 'estimated' | 'simulated' | 'live';

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
  price: string;
  evidenceType: EvidenceType;
}

export interface TokenEstimateResult {
  rulesVersion: string;
  mode: 'estimated';
  scope: { rag: boolean; agent: boolean; summary: string };
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
    input: TokenLine[];
  };
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
    contextExpansionRatio: number;
  } | null;
  agent: {
    pattern: string;
    llmCallsPerTask: number;
    toolCallsPerTask: number;
    tokensPerTask: number;
    steps: Array<{ step: string; inputTokens: number; outputTokens: number }>;
    costPerTaskUsd: number | null;
    loopGuard: string;
  } | null;
  monthly: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; embeddingTokens: number; rerankingTokens: number; basis: string };
  cost: { currency: string; lines: CostLine[]; monthlyUsd: number | null; perRequestUsd: number | null; note: string };
  budget: { monthlyBudgetUsd: number | null; shareOfBudget: number | null; source: string | null };
  assumptions: string[];
  gaps: string[];
  wouldChangeIf: string[];
}

export interface TokenEstimate {
  id: string;
  version: number;
  submitted: Record<string, unknown>;
  sources: Record<string, { source: string; detail: string }>;
  result: TokenEstimateResult;
  rulesVersion: string;
  createdAt: string;
}

export interface TokenEstimatePreview {
  sources: Record<string, { source: string; detail: string }>;
  result: TokenEstimateResult;
}

// ------------------------------------------------------------ observed usage (Phase 3 APIs)

export type ObservedMode = 'simulated' | 'live';
export type TelemetryStatus = 'no_telemetry' | 'simulated_only' | 'receiving' | 'stale';
export const FILTER_NAMES = ['environment', 'application', 'service', 'workflow', 'provider', 'model', 'tenant'] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

/** The shared filters (spec §4, §19); kept in the URL so a drill-down can be shared. */
export interface UsageFilters {
  mode: ObservedMode;
  from: string;
  to: string;
  dims: Partial<Record<FilterName, string>>;
}

export const toParams = (f: UsageFilters, extra: Record<string, string | number | undefined> = {}) => {
  const p = new URLSearchParams({ mode: f.mode, from: f.from, to: f.to });
  for (const [k, v] of Object.entries(f.dims)) if (v) p.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
};

interface Range {
  mode: ObservedMode;
  from: string;
  to: string;
  filters: Partial<Record<FilterName, string>>;
}

export interface UsageSummary extends Range {
  telemetry: { status: TelemetryStatus; lastLive: string | null; lastSimulated: string | null };
  empty: boolean;
  cards: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    requests: number;
    tokensPerRequest: number | null;
    cost: number | null;
    costIncomplete: boolean;
    topConsumer: { application: string | null; service: string | null; totalTokens: number } | null;
    growthVsBaselinePercent: number | null;
    growthNote: string | null;
    baselineTotalTokens: number;
  };
}

export type TokenTotals = Record<'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cachedInputTokens' | 'totalTokens' | 'embeddingTokens' | 'rerankingTokens' | 'contextTokens' | 'llmCalls' | 'toolCalls' | 'cost' | 'events', number>;

export interface UsageTokens extends Range {
  totals: TokenTotals;
  requests: number;
  successfulRequestTokens: number;
  errors: number;
  tokensPerRequest: number | null;
  llmCallsPerRequest: number | null;
  toolCallsPerRequest: number | null;
  latencyMs: { avg: number | null; p95: number | null };
  ttftMs: { avg: number | null };
}

export interface TrendPoint extends TokenTotals {
  bucket: string;
}

export interface UsageTrends extends Range {
  bucket: 'hour' | 'day';
  points: TrendPoint[];
}

export interface GroupRow extends TokenTotals {
  share: number;
  latencyMsSum: number;
  errors: number;
  avgLatencyMs?: number | null;
  applicationId?: string | null;
  serviceId?: string | null;
  workflowId?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface UsageGroups extends Range {
  rows: GroupRow[];
}

export interface UsageAgents extends Range {
  loopThreshold: number;
  agents: Array<{
    agentId: string;
    tasks: number;
    llmCallsPerTask: number;
    toolCallsPerTask: number;
    tokensPerTask: number;
    costPerTask: number | null;
    costIncomplete: boolean;
    totalTokens: number;
    maxLlmCallsPerTask: number;
    tasksOverLimit: number;
    steps: Array<{ operationType: string; toolName: string | null; calls: number; inputTokens: number; outputTokens: number; totalTokens: number; avgLatencyMs: number | null }>;
  }>;
}

export interface UsageRag extends Range {
  empty: boolean;
  requests: number;
  stages: Array<{ stage: string; events: number; requests: number; inputTokens: number; outputTokens: number; embeddingTokens: number; rerankingTokens: number; contextTokens: number; retrievalCount: number; cost: number | null }>;
  perRequest: { queryEmbeddingTokens: number; retrievedChunks: number; rerankingTokens: number; contextTokens: number; finalInputTokens: number; outputTokens: number } | null;
  contextExpansionRatio: number | null;
}

export interface UsageCost extends Range {
  currency: string;
  observedCost: number | null;
  costIncomplete: boolean;
  unpricedEvents: number;
  byModel: Array<{ provider: string | null; model: string | null; cost: number; totalTokens: number; embeddingTokens: number }>;
  forecast: { monthlyRunRate: number | null; basis: string };
  estimate: { version: number; monthlyUsd: number | null; deltaPercent: number | null } | null;
  budget: { monthlyUsd: number; shareUsed: number | null; source: string | null } | null;
}

export interface RequestRow {
  request: string;
  traceId: string | null;
  started: string;
  applicationId: string | null;
  serviceId: string | null;
  workflowId: string | null;
  agentId: string | null;
  models: string;
  spans: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  embeddingTokens: number;
  llmCalls: number;
  toolCalls: number;
  cost: number | null;
  costIncomplete: boolean;
  failed: boolean;
  maxLatencyMs: number | null;
}

export interface UsageRequests extends Range {
  sort: 'recent' | 'tokens' | 'cost';
  offset: number;
  hasMore: boolean;
  rows: RequestRow[];
}

export interface SpanNode {
  eventId: string;
  timestamp: string;
  spanId: string | null;
  parentSpanId: string | null;
  operationType: string;
  provider: string;
  model: string;
  agentId: string | null;
  toolName: string | null;
  ragStage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  embeddingTokens: number;
  rerankingTokens: number;
  llmCallCount: number;
  toolCallCount: number;
  latencyMs: number | null;
  ttftMs: number | null;
  requestStatus: string;
  errorType: string | null;
  estimatedTotalCost: number | null;
  children: SpanNode[];
}

export interface UsageTrace {
  traceId: string;
  telemetrySource: ObservedMode[];
  spans: number;
  roots: SpanNode[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; embeddingTokens: number; rerankingTokens: number; llmCalls: number; toolCalls: number; costUsd: number | null; unpricedSpans: number; durationMs: number; errors: number };
  loop: { threshold: number; excessiveLlmCalls: boolean; repeatedTools: Array<{ tool: string; calls: number }> };
}

export interface UsageDimensions extends Range {
  values: Record<FilterName | 'agent', string[]>;
}
