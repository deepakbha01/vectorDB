import { Eligibility, EvidenceType } from '../ai-factory.types';

export type ToolAccess = 'none' | 'read_only' | 'read_write' | 'external_actions';
export type DecisionArea = 'retrieval' | 'reranking' | 'agent';

interface Tiers {
  relevance?: number;
  latency: number;
  operationalSimplicity: number;
  controllability?: number;
  flexibility?: number;
  cost?: number;
}

export interface RetrievalOption extends Tiers {
  id: string;
  label: string;
  keyword: boolean;
  requiresNativeHybrid: boolean;
  extraComponent: string | null;
  relevance: number;
}

export interface RerankOption extends Tiers {
  id: string;
  label: string;
  external: boolean;
  usesLlm: boolean;
  relevance: number;
  cost: number;
}

export interface AgentOption extends Tiers {
  id: string;
  label: string;
  requiresToolCalling: boolean;
  maxSteps: number;
  controllability: number;
  flexibility: number;
}

export interface RagAgentCatalogue {
  rulesVersion: string;
  retrieval: { options: RetrievalOption[]; weights: Record<'relevance' | 'latency' | 'operationalSimplicity', number> };
  reranking: { options: RerankOption[]; weights: Record<'relevance' | 'latency' | 'operationalSimplicity' | 'cost', number>; candidateMultiplier: number; maxCandidates: number };
  agent: { options: AgentOption[]; weights: Record<'controllability' | 'flexibility' | 'latency' | 'operationalSimplicity', number>; multiAgentMinOps: string };
  priorityMultiplier: number;
  opsCapabilityOrder: string[];
  assumptions: {
    latencyMs: {
      queryEmbeddingSelfHosted: number;
      queryEmbeddingApi: number;
      vectorSearchDefault: number;
      keywordFusion: number;
      appFusion: number;
      promptAssembly: number;
      crossEncoderBase: number;
      crossEncoderPerCandidate: number;
      managedRerankApi: number;
      toolCall: number;
    };
    tokens: { systemPrompt: number; conversationHistory: number; toolSchemas: number; toolResultPerStep: number; defaultOutputReserve: number };
    maxContextUtilisation: number;
  };
}

export interface ModelFacts {
  id: string;
  label: string;
  contextWindow: number;
  toolCalling: boolean;
  structuredOutput: boolean;
  family: string;
}

/** Everything the design is judged against, resolved from earlier phases (see sources). */
export interface RagAgentContext {
  rag: boolean;
  agent: boolean;
  architectureClass: string | null;
  // search requirements (Discovery)
  requiresHybridSearch: boolean;
  requiresFullTextSearch: boolean;
  requiresMetadataFiltering: boolean;
  requiresReranking: boolean;
  requiresTenantIsolation: boolean;
  topK: number;
  precisionTarget: number | null;
  vectorSearchP95Ms: number | null;
  // vector database (Vector DB decision + databases.yaml)
  vectorPlatform: string | null;
  nativeHybrid: boolean | null;
  nativeFiltering: boolean | null;
  // data pipeline
  chunkTokens: number | null;
  embeddingModel: string | null;
  embeddingSelfHosted: boolean | null;
  metadataFields: Array<{ name: string; filterable: boolean; searchable: boolean }>;
  // models and serving
  primary: ModelFacts | null;
  fallback: ModelFacts | null;
  accuracyRequirement: 'standard' | 'high' | 'critical';
  latencyPriority: 'low' | 'medium' | 'high';
  ttftP95Ms: number | null;
  tpotMs: number | null;
  outputTokens: number;
  ttftTargetMs: number | null;
  e2eTargetMs: number | null;
  // boundary and operations
  onPremOnly: boolean;
  thirdPartyApiAllowed: boolean;
  restrictedData: boolean;
  containsPii: boolean;
  businessCriticality: string | null;
  opsCapability: string;
  hasGpu: boolean | null;
  policyEngine: boolean;
  // architect choices (form)
  citationsRequired: boolean;
  multiTurn: boolean;
  toolAccess: ToolAccess;
  longTermMemory: boolean;
  openEndedTasks: boolean;
}

export interface EvaluatedOption {
  area: DecisionArea;
  id: string;
  label: string;
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  score: number;
}

export interface AreaDecision {
  area: DecisionArea;
  title: string;
  chosen: EvaluatedOption | null;
  candidates: EvaluatedOption[];
  why: string;
}

export interface BudgetLine {
  stage: string;
  ms: number;
  evidenceType: EvidenceType;
  detail: string;
}

export interface RagAgentResult {
  rulesVersion: string;
  scope: { rag: boolean; agent: boolean; summary: string };
  decisions: AreaDecision[];
  confidence: 'high' | 'medium' | 'low';
  rag: Record<'semanticSearch' | 'hybridSearch' | 'metadataFiltering' | 'reranking' | 'contextConstruction' | 'promptConstruction' | 'citation' | 'grounding' | 'hallucinationMitigation', string[]> | null;
  agent: Record<'orchestration' | 'toolCalling' | 'memory' | 'planning' | 'guardrails' | 'humanApproval' | 'toolSecurity' | 'isolation', string[]> | null;
  contextBudget: {
    lines: Array<{ label: string; tokens: number; evidenceType: EvidenceType }>;
    totalTokens: number;
    limitTokens: number | null;
    fits: boolean | null;
    note: string;
  };
  latencyBudget: {
    lines: BudgetLine[];
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
