/** RAG / Agent architecture (AI Factory Wave 6) - mirrors backend/src/ai-factory/rag-agent/*. */
import { Eligibility, EvidenceType } from './aiFactory';

export type ToolAccess = 'none' | 'read_only' | 'read_write' | 'external_actions';
export const TOOL_ACCESS: Array<[ToolAccess, string]> = [
  ['none', 'No tools'],
  ['read_only', 'Read-only tools'],
  ['read_write', 'Read and write'],
  ['external_actions', 'External actions'],
];

export interface CreateRagAgentDesignInput {
  includeRag?: boolean;
  includeAgent?: boolean;
  citationsRequired?: boolean;
  multiTurn?: boolean;
  toolAccess?: ToolAccess;
  openEndedTasks?: boolean;
  longTermMemory?: boolean;
}

export interface EvaluatedOption {
  area: 'retrieval' | 'reranking' | 'agent';
  id: string;
  label: string;
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  score: number;
}

export interface AreaDecision {
  area: EvaluatedOption['area'];
  title: string;
  chosen: EvaluatedOption | null;
  candidates: EvaluatedOption[];
  why: string;
}

export interface RagAgentResult {
  rulesVersion: string;
  scope: { rag: boolean; agent: boolean; summary: string };
  decisions: AreaDecision[];
  confidence: 'high' | 'medium' | 'low';
  rag: Record<'semanticSearch' | 'hybridSearch' | 'metadataFiltering' | 'reranking' | 'contextConstruction' | 'promptConstruction' | 'citation' | 'grounding' | 'hallucinationMitigation', string[]> | null;
  agent: Record<'orchestration' | 'toolCalling' | 'memory' | 'planning' | 'guardrails' | 'humanApproval' | 'toolSecurity' | 'isolation', string[]> | null;
  contextBudget: { lines: Array<{ label: string; tokens: number; evidenceType: EvidenceType }>; totalTokens: number; limitTokens: number | null; fits: boolean | null; note: string };
  latencyBudget: {
    lines: Array<{ stage: string; ms: number; evidenceType: EvidenceType; detail: string }>;
    timeToFirstTokenMs: number | null;
    ttftTargetMs: number | null;
    meetsTtftTarget: boolean | null;
    endToEndMs: number | null;
    e2eTargetMs: number | null;
    meetsE2eTarget: boolean | null;
  };
  components: Array<{ layer: string; component: string; detail: string }>;
  gaps: string[];
  wouldChangeIf: string[];
  benchmarkRequired: string[];
}

export interface RagAgentContext {
  rag: boolean;
  agent: boolean;
  citationsRequired: boolean;
  multiTurn: boolean;
  toolAccess: ToolAccess;
  openEndedTasks: boolean;
  longTermMemory: boolean;
  vectorPlatform: string | null;
  embeddingModel: string | null;
  topK: number;
  primary: { label: string } | null;
}

export type RagAgentSources = Record<string, { source: string; detail: string }>;

export interface RagAgentDesign {
  id: string;
  version: number;
  submitted: CreateRagAgentDesignInput;
  context: RagAgentContext;
  sources: RagAgentSources;
  result: RagAgentResult;
  createdAt: string;
}

export interface RagAgentDefaults {
  context: RagAgentContext;
  sources: RagAgentSources;
  preview: RagAgentResult;
}
