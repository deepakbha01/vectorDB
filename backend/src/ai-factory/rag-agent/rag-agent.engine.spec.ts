import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { designRagAgent, evaluateAgent, evaluateRerank, evaluateRetrieval, weightsFor } from './rag-agent.engine';
import { resolveRagAgentContext } from './rag-agent.service';
import { fromRagAgentDesign } from '../decision-record.adapters';
import { RagAgentCatalogue, RagAgentContext } from './rag-agent.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/rag-agent.yaml'), 'utf8')) as RagAgentCatalogue;
const opt = <T extends { id: string }>(list: T[], id: string) => list.find((o) => o.id === id)!;

const ctx = (o: Partial<RagAgentContext> = {}): RagAgentContext => ({
  rag: true,
  agent: false,
  architectureClass: 'rag',
  requiresHybridSearch: false,
  requiresFullTextSearch: false,
  requiresMetadataFiltering: false,
  requiresReranking: false,
  requiresTenantIsolation: false,
  topK: 5,
  precisionTarget: null,
  vectorSearchP95Ms: 40,
  vectorPlatform: 'qdrant',
  nativeHybrid: true,
  nativeFiltering: true,
  chunkTokens: 400,
  embeddingModel: 'bge-large-en-v1.5',
  embeddingSelfHosted: true,
  metadataFields: [
    { name: 'source_url', filterable: true, searchable: false },
    { name: 'department', filterable: true, searchable: false },
    { name: 'body', filterable: false, searchable: true },
  ],
  primary: { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', contextWindow: 131072, toolCalling: true, structuredOutput: true, family: 'open_weight' },
  fallback: { id: 'llama-3.1-8b', label: 'Llama 3.1 8B', contextWindow: 131072, toolCalling: true, structuredOutput: true, family: 'open_weight' },
  accuracyRequirement: 'standard',
  latencyPriority: 'medium',
  ttftP95Ms: 400,
  tpotMs: 30,
  outputTokens: 300,
  ttftTargetMs: 1500,
  e2eTargetMs: 15000,
  onPremOnly: false,
  thirdPartyApiAllowed: true,
  restrictedData: false,
  containsPii: false,
  businessCriticality: 'medium',
  opsCapability: 'dedicated_team',
  hasGpu: true,
  policyEngine: true,
  citationsRequired: true,
  multiTurn: false,
  toolAccess: 'none',
  longTermMemory: false,
  openEndedTasks: false,
  ...o,
});
const chosen = (r: ReturnType<typeof designRagAgent>, area: string) => r.decisions.find((d) => d.area === area)!.chosen?.id ?? null;

describe('RAG / agent catalogue (config/rag-agent.yaml)', () => {
  it('has weights that sum to 1 and no product names as options', () => {
    for (const w of [cat.retrieval.weights, cat.reranking.weights, cat.agent.weights]) expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const ids = [...cat.retrieval.options, ...cat.reranking.options, ...cat.agent.options].map((o) => o.id);
    expect(ids).toEqual(['semantic', 'hybrid_native', 'hybrid_app_fusion', 'none', 'cross_encoder', 'managed_rerank_api', 'llm_rerank', 'workflow_graph', 'single_agent', 'multi_agent']);
  });

  it('re-normalises weights when a priority emphasises a criterion', () => {
    const w = weightsFor(cat.reranking.weights, ['relevance'], cat.priorityMultiplier);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(w.relevance).toBeGreaterThan(cat.reranking.weights.relevance);
  });
});

describe('retrieval eligibility', () => {
  it('rules out dense-only search when Discovery requires hybrid or full-text search', () => {
    const v = evaluateRetrieval(opt(cat.retrieval.options, 'semantic'), ctx({ requiresHybridSearch: true, requiresFullTextSearch: true }));
    expect(v.failures).toEqual(['Discovery requires hybrid (vector + keyword) search.', 'Discovery requires full-text search, which dense vectors alone do not provide.']);
  });

  it('falls back to application-side fusion when the database has no native hybrid search', () => {
    const r = designRagAgent(ctx({ vectorPlatform: 'chroma', nativeHybrid: false, requiresHybridSearch: true }), cat);
    const d = r.decisions.find((x) => x.area === 'retrieval')!;
    expect(d.candidates.find((c) => c.id === 'hybrid_native')!.failures[0]).toBe('chroma has no native hybrid search (databases catalogue).');
    expect(d.chosen!.id).toBe('hybrid_app_fusion');
    expect(d.chosen!.eligibility).toBe('conditional');
    expect(d.why).toMatch(/consistency checks\.$/);
    expect(r.latencyBudget.lines.find((l) => l.stage === 'Keyword search + fusion')!.ms).toBe(cat.assumptions.latencyMs.appFusion);
  });

  it('makes native hybrid conditional before a vector database is chosen', () => {
    expect(evaluateRetrieval(opt(cat.retrieval.options, 'hybrid_native'), ctx({ vectorPlatform: null, nativeHybrid: null })).conditions[0]).toMatch(/No Vector DB decision yet/);
  });
});

describe('reranking eligibility and defaults', () => {
  it('uses no reranker by default and a self-hosted cross-encoder when accuracy matters', () => {
    expect(chosen(designRagAgent(ctx(), cat), 'reranking')).toBe('none');
    expect(chosen(designRagAgent(ctx({ accuracyRequirement: 'high' }), cat), 'reranking')).toBe('cross_encoder');
  });

  it('requires a reranker when Discovery does', () => {
    const r = designRagAgent(ctx({ requiresReranking: true }), cat);
    expect(r.decisions[1].candidates.find((c) => c.id === 'none')!.failures).toEqual(['Discovery requires reranking.']);
    expect(chosen(r, 'reranking')).not.toBe('none');
  });

  it.each([
    ['on-premises only', { onPremOnly: true }, /Only on-premises deployment is allowed/],
    ['third-party APIs disallowed', { thirdPartyApiAllowed: false }, /Third-party APIs are not allowed/],
  ])('keeps passages in the boundary: %s', (_n, o, msg) => {
    expect(evaluateRerank(opt(cat.reranking.options, 'managed_rerank_api'), ctx(o as Partial<RagAgentContext>), cat, 500).failures[0]).toMatch(msg as RegExp);
  });

  it('makes a managed API conditional for PII, and any reranker conditional when it breaks the TTFT target', () => {
    expect(evaluateRerank(opt(cat.reranking.options, 'managed_rerank_api'), ctx({ containsPii: true }), cat, 500).conditions[0]).toMatch(/DPA \/ BAA/);
    const v = evaluateRerank(opt(cat.reranking.options, 'llm_rerank'), ctx({ ttftTargetMs: 600 }), cat, 470);
    expect(v.conditions[0]).toBe('Adds ~400 ms, taking time to first token to ~870 ms against a 600 ms target.');
  });
});

describe('reranking against a target that is already missed', () => {
  it('does not hold an existing TTFT overrun against every reranker - it is reported once as a gap', () => {
    expect(evaluateRerank(opt(cat.reranking.options, 'cross_encoder'), ctx({ ttftTargetMs: 400 }), cat, 470).conditions).toEqual([]);
    const r = designRagAgent(ctx({ accuracyRequirement: 'critical', ttftTargetMs: 400 }), cat);
    expect(chosen(r, 'reranking')).toBe('cross_encoder');
    expect(r.gaps.join(' ')).toMatch(/exceeds the 400 ms target/);
  });
});

describe('agent orchestration', () => {
  const agentCtx = (o: Partial<RagAgentContext> = {}) => ctx({ agent: true, toolAccess: 'read_only', ...o });

  it('prefers the deterministic workflow, and a tool-calling agent for open-ended tasks', () => {
    expect(chosen(designRagAgent(agentCtx(), cat), 'agent')).toBe('workflow_graph');
    const open = designRagAgent(agentCtx({ openEndedTasks: true }), cat);
    expect(chosen(open, 'agent')).toBe('single_agent');
    expect(open.decisions.find((d) => d.area === 'agent')!.candidates.find((c) => c.id === 'workflow_graph')!.eligibility).toBe('conditional');
  });

  it('keeps open-ended tasks with external actions on a tool-calling agent, behind the approval gate', () => {
    const r = designRagAgent(agentCtx({ openEndedTasks: true, toolAccess: 'external_actions' }), cat);
    const d = r.decisions.find((x) => x.area === 'agent')!;
    expect(d.chosen!.id).toBe('single_agent');
    expect(d.chosen!.eligibility).toBe('eligible');
    expect(d.chosen!.notes.join(' ')).toMatch(/human-approval gate/);
    expect(d.candidates.find((c) => c.id === 'workflow_graph')!.eligibility).toBe('conditional');
  });

  it('keeps option labels as written in the summary', () => {
    expect(designRagAgent(agentCtx(), cat).scope.summary).toContain('with LLM steps');
  });

  it('rules out tool-calling patterns when the primary model cannot call tools', () => {
    const r = designRagAgent(agentCtx({ openEndedTasks: true, primary: { ...ctx().primary!, label: 'Tiny', toolCalling: false } }), cat);
    const d = r.decisions.find((x) => x.area === 'agent')!;
    expect(d.candidates.filter((c) => c.eligibility === 'not_eligible').map((c) => c.id).sort()).toEqual(['multi_agent', 'single_agent']);
    expect(d.chosen!.id).toBe('workflow_graph');
  });

  it('puts conditions on autonomy: operations maturity, external actions and the latency target', () => {
    const multi = opt(cat.agent.options, 'multi_agent');
    const v = evaluateAgent(multi, agentCtx({ opsCapability: 'part_time', toolAccess: 'external_actions', businessCriticality: 'mission_critical' }), cat, 2000);
    expect(v.conditions.join(' ')).toMatch(/at least a dedicated team/);
    expect(v.conditions.join(' ')).toMatch(/human approval on every external action/);
    const slow = evaluateAgent(multi, agentCtx({ e2eTargetMs: 4000 }), cat, 2000);
    expect(slow.conditions[0]).toBe('Up to 8 steps adds ~4,550 ms, taking a response to ~6,550 ms against a 4,000 ms target.');
  });

  it('designs approvals, memory and isolation from the inputs', () => {
    const r = designRagAgent(agentCtx({ toolAccess: 'external_actions', multiTurn: true, longTermMemory: true, containsPii: true, requiresTenantIsolation: true, restrictedData: true }), cat);
    expect(r.agent!.humanApproval[0]).toMatch(/before every external action/);
    expect(r.agent!.memory.join(' ')).toMatch(/per-user memories .* PII redaction/);
    expect(r.agent!.isolation.join(' ')).toMatch(/Per-tenant isolation/);
    expect(r.agent!.toolCalling.join(' ')).toMatch(/idempotency keys/);
  });
});

describe('budgets and gaps', () => {
  it('adds up the latency budget stage by stage', () => {
    const r = designRagAgent(ctx(), cat);
    // embedding 15 + search 40 + in-engine fusion 10 + prompt 5 + TTFT 400 = 470; generation 300 × 30 = 9,000
    expect(r.latencyBudget.timeToFirstTokenMs).toBe(470);
    expect(r.latencyBudget.endToEndMs).toBe(9470);
    expect(r.latencyBudget.meetsTtftTarget).toBe(true);
  });

  it('flags a prompt that does not fit the model and says how much to cut', () => {
    const r = designRagAgent(ctx({ topK: 20, chunkTokens: 1000, primary: { ...ctx().primary!, contextWindow: 8192 } }), cat);
    expect(r.contextBudget.fits).toBe(false);
    expect(r.contextBudget.totalTokens).toBe(800 + 20_000 + 300);
    expect(r.gaps.join(' ')).toMatch(/Reduce top-K by ~15/);
  });

  it('reports missing citation sources and filter fields as gaps', () => {
    const r = designRagAgent(ctx({ requiresMetadataFiltering: true, metadataFields: [{ name: 'body', filterable: false, searchable: true }] }), cat);
    expect(r.gaps).toEqual(expect.arrayContaining([
      'Metadata filtering is required but the pipeline defines no filterable fields.',
      'Citations are required but no source / document-id field exists in the Data Pipeline Design metadata.',
    ]));
    expect(r.confidence).toBe('medium');
  });

  it('becomes a standard decision record with at most two usable alternatives', () => {
    const r = designRagAgent(ctx({ agent: true, toolAccess: 'read_only' }), cat);
    const rec = fromRagAgentDesign({ id: 'r', version: 1, createdAt: new Date(), sources: { x: { source: 'default', detail: 'd' } }, result: r } as any);
    expect(rec.phase).toBe('rag_agent_architecture');
    expect(rec.recommendation!.label).toBe(r.scope.summary);
    expect(rec.alternatives.length).toBeLessThanOrEqual(2);
    expect(rec.alternatives.every((a) => a.eligibility !== 'not_eligible')).toBe(true);
    expect(rec.evidence.some((e) => e.label.startsWith('Latency: '))).toBe(true);
  });
});

describe('resolveRagAgentContext', () => {
  const catalogues = {
    databases: [{ id: 'chroma', supportsHybridSearch: false, supportsMetadataFiltering: true }],
    models: [{ id: 'm1', contextWindow: 32768, capabilities: ['tool_calling'] }] as any,
    charsPerToken: 4,
    defaultOutputTokens: 1000,
  };
  const inputs = (o: Record<string, any> = {}): any => ({
    project: { platform: 'undetermined' },
    profile: {
      version: 2,
      inputs: { workloadTypes: { value: ['rag', 'agentic'] }, deploymentTargets: { value: ['on_premises'] }, hasGpu: { value: true }, containsPii: { value: false }, businessCriticality: { value: 'high' }, targetTtftMs: { value: 800 }, targetLatencyMs: { value: 6000 } },
      result: { architecture: { class: 'hybrid', label: 'Hybrid (RAG + agent)', components: ['rag', 'agent'] }, dataClassification: { level: 'confidential' } },
    },
    discovery: { version: 3, requiresHybridSearch: true, requiresFullTextSearch: false, requiresMetadataFiltering: true, requiresReranking: false, requiresTenantIsolation: false, topK: 8, targetP95LatencyMs: 50, containsPii: true, hasGpu: false, operationalCapability: 'part_time' },
    pipeline: { version: 1, chunkingStrategy: 'fixed_size', chunkSize: 2000, embeddingModelId: 'bge', embeddingProviderId: 'open_source', metadataFields: [{ name: 'doc_id' }] },
    adr: { decision: 'chroma' },
    selection: { version: 4, requirements: { accuracyRequirement: 'high', latencyPriority: 'medium' }, result: { primary: { id: 'm1', label: 'Model One', family: 'open_weight' }, fallback: null } },
    inference: null,
    architecture: null,
    ...o,
  });

  it('derives scope, search facts and model facts from the upstream records, with sources', () => {
    const { context, sources } = resolveRagAgentContext({}, inputs(), catalogues);
    expect(context).toMatchObject({
      rag: true, agent: true, multiTurn: true, toolAccess: 'read_only', citationsRequired: true,
      nativeHybrid: false, chunkTokens: 500, embeddingSelfHosted: true, onPremOnly: true, thirdPartyApiAllowed: false,
      containsPii: true, hasGpu: true, ttftTargetMs: 800, e2eTargetMs: 6000, accuracyRequirement: 'high', outputTokens: 1000,
    });
    expect(context.primary).toEqual({ id: 'm1', label: 'Model One', family: 'open_weight', contextWindow: 32768, toolCalling: true, structuredOutput: false });
    expect(context.metadataFields).toEqual([{ name: 'doc_id', filterable: true, searchable: false }]);
    expect(sources.includeAgent.detail).toBe('Workload Profile v2: Hybrid (RAG + agent)');
    expect(sources.toolAccess.source).toBe('default');
  });

  it('lets the architect override scope and choices', () => {
    const { context, sources } = resolveRagAgentContext({ includeAgent: false, citationsRequired: false }, inputs(), catalogues);
    expect(context.agent).toBe(false);
    expect(context.citationsRequired).toBe(false);
    expect(sources.includeAgent.source).toBe('user');
  });

  it('refuses to design with no inputs or nothing in scope', () => {
    expect(() => resolveRagAgentContext({}, inputs({ profile: null, discovery: null }), catalogues)).toThrow(BadRequestException);
    expect(() => resolveRagAgentContext({ includeRag: false, includeAgent: false }, inputs(), catalogues)).toThrow(/Neither RAG nor an agent/);
  });
});
