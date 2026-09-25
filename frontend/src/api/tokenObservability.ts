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
