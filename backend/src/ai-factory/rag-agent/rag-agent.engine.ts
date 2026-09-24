import { EvidenceType } from '../ai-factory.types';
import {
  AgentOption,
  AreaDecision,
  BudgetLine,
  DecisionArea,
  EvaluatedOption,
  RagAgentCatalogue,
  RagAgentContext,
  RagAgentResult,
  RerankOption,
  RetrievalOption,
} from './rag-agent.types';

const TIE_EPSILON = 0.001;
const band = (o: EvaluatedOption) => (o.eligibility === 'eligible' ? 0 : o.eligibility === 'conditional' ? 1 : 2);
const round = (n: number) => Math.round(n * 1000) / 1000;
const HIGH_CRITICALITY = ['high', 'mission_critical'];
/** Metadata that lets an answer point back at its source. */
const SOURCE_FIELD = /source|doc(ument)?_?id|document|url|uri|path|title|file/i;

type Verdict = Pick<EvaluatedOption, 'failures' | 'conditions' | 'notes'>;
const verdict = (): Verdict => ({ failures: [], conditions: [], notes: [] });
const eligibilityOf = (v: Verdict): EvaluatedOption['eligibility'] => (v.failures.length ? 'not_eligible' : v.conditions.length ? 'conditional' : 'eligible');

/** Weights normalised to 1 after the stated priorities emphasise their criterion. */
export function weightsFor<K extends string>(base: Record<K, number>, emphasise: K[], multiplier: number): Record<K, number> {
  const raised = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, (v as number) * (emphasise.includes(k as K) ? multiplier : 1)])) as Record<K, number>;
  const total = Object.values(raised).reduce((a: number, b) => a + (b as number), 0) as number;
  return Object.fromEntries(Object.entries(raised).map(([k, v]) => [k, (v as number) / total])) as Record<K, number>;
}

const score = (tiers: Record<string, number | undefined>, w: Record<string, number>) => round(Object.entries(w).reduce((s, [k, wk]) => s + wk * ((tiers[k] ?? 0) / 5), 0));

function decide(area: DecisionArea, title: string, candidates: EvaluatedOption[]): AreaDecision {
  const sorted = [...candidates].sort((a, b) => band(a) - band(b) || (Math.abs(b.score - a.score) > TIE_EPSILON ? b.score - a.score : a.id.localeCompare(b.id)));
  const chosen = sorted.find((c) => c.eligibility !== 'not_eligible') ?? null;
  const usable = sorted.filter((c) => c.eligibility !== 'not_eligible');
  const betterConditional = chosen?.eligibility === 'eligible' && usable.some((c) => c.eligibility === 'conditional' && c.score > chosen.score + TIE_EPSILON);
  const tied = chosen ? usable.filter((c) => c !== chosen && c.eligibility === chosen.eligibility && Math.abs(c.score - chosen.score) <= TIE_EPSILON) : [];
  const why = !chosen
    ? `No usable option - ${sorted[0]?.failures[0] ?? 'nothing to choose from'}`
    : [
        `${chosen.label}: ${betterConditional ? 'the highest-scoring option without conditions' : 'highest score'} (${chosen.score}) among ${usable.length} usable option(s)`,
        betterConditional ? ' - a higher-scoring option is conditional, and eligible options rank first' : '',
        tied.length ? `; tied with ${tied.map((t) => t.label).join(', ')} - broken by option id` : '',
        chosen.eligibility === 'conditional' ? `; conditions: ${chosen.conditions.join(' ').replace(/\.$/, '')}` : '',
        '.',
      ].join('');
  return { area, title, chosen, candidates: sorted, why };
}

export function rerankCandidates(ctx: RagAgentContext, cat: RagAgentCatalogue): number {
  return Math.min(ctx.topK * cat.reranking.candidateMultiplier, cat.reranking.maxCandidates);
}

/** Added latency of each reranking option (ms), or null when the input it needs is unknown. */
export function rerankMs(o: RerankOption, ctx: RagAgentContext, cat: RagAgentCatalogue): number | null {
  const a = cat.assumptions.latencyMs;
  if (o.id === 'none') return 0;
  if (o.usesLlm) return ctx.ttftP95Ms;
  if (o.external) return a.managedRerankApi;
  return Math.round(a.crossEncoderBase + a.crossEncoderPerCandidate * rerankCandidates(ctx, cat));
}

function retrievalMs(o: RetrievalOption | null, ctx: RagAgentContext, cat: RagAgentCatalogue): BudgetLine[] {
  if (!ctx.rag) return [];
  const a = cat.assumptions.latencyMs;
  const lines: BudgetLine[] = [
    {
      stage: 'Query embedding',
      ms: ctx.embeddingSelfHosted === false ? a.queryEmbeddingApi : a.queryEmbeddingSelfHosted,
      evidenceType: 'assumption',
      detail: ctx.embeddingSelfHosted === false ? `${ctx.embeddingModel ?? 'embedding'} via API` : `${ctx.embeddingModel ?? 'embedding model'} self-hosted`,
    },
    ctx.vectorSearchP95Ms !== null
      ? { stage: 'Vector search', ms: ctx.vectorSearchP95Ms, evidenceType: 'assumption', detail: 'at the Discovery P95 search target (not measured)' }
      : { stage: 'Vector search', ms: a.vectorSearchDefault, evidenceType: 'assumption', detail: 'planning default - no Discovery search target' },
  ];
  if (o?.keyword) lines.push({ stage: 'Keyword search + fusion', ms: o.extraComponent ? a.appFusion : a.keywordFusion, evidenceType: 'assumption', detail: o.extraComponent ? 'separate keyword index + reciprocal-rank fusion' : 'in-engine hybrid' });
  return lines;
}

// ---------------------------------------------------------------- retrieval
export function evaluateRetrieval(o: RetrievalOption, ctx: RagAgentContext): Verdict {
  const v = verdict();
  if (!o.keyword) {
    if (ctx.requiresHybridSearch) v.failures.push('Discovery requires hybrid (vector + keyword) search.');
    if (ctx.requiresFullTextSearch) v.failures.push('Discovery requires full-text search, which dense vectors alone do not provide.');
    if (!v.failures.length) v.notes.push('Exact identifiers (codes, names, SKUs) retrieve poorly without keyword matching - check the evaluation set covers them.');
  }
  if (o.requiresNativeHybrid) {
    if (ctx.nativeHybrid === false) v.failures.push(`${ctx.vectorPlatform} has no native hybrid search (databases catalogue).`);
    else if (ctx.nativeHybrid === null) v.conditions.push('No Vector DB decision yet - confirm the chosen database supports hybrid search natively.');
  }
  if (o.extraComponent) v.conditions.push(`Adds a component to run: ${o.extraComponent.toLowerCase()}, with its own ingestion path and consistency checks.`);
  return v;
}

// ---------------------------------------------------------------- reranking
export function evaluateRerank(o: RerankOption, ctx: RagAgentContext, cat: RagAgentCatalogue, ttftWithout: number | null): Verdict {
  const v = verdict();
  const n = rerankCandidates(ctx, cat);
  if (o.id === 'none') {
    if (ctx.requiresReranking) v.failures.push('Discovery requires reranking.');
    else if (ctx.precisionTarget !== null && ctx.precisionTarget >= 0.8) v.notes.push(`Precision target ${ctx.precisionTarget} is demanding without a reranker - verify on the evaluation set.`);
    if (!ctx.requiresReranking && ctx.accuracyRequirement === 'critical') v.notes.push('Accuracy is critical - skipping a reranker trades answer quality for latency; confirm on the evaluation set.');
  }
  if (o.external) {
    if (ctx.onPremOnly) v.failures.push('Only on-premises deployment is allowed - candidate passages would leave the boundary.');
    else if (!ctx.thirdPartyApiAllowed) v.failures.push('Third-party APIs are not allowed (Inference assessment).');
    else if (ctx.restrictedData || ctx.containsPii) v.conditions.push('Passages sent to a third party contain regulated data - needs a DPA / BAA, regional endpoint and redaction where possible.');
  }
  if (o.id === 'cross_encoder' && ctx.hasGpu === false && n > 50) v.notes.push(`${n} candidates on CPU - consider a GPU or fewer candidates if the latency budget is tight.`);
  if (o.usesLlm && ctx.ttftP95Ms === null) v.conditions.push('No inference latency estimate yet - an extra LLM call per request cannot be budgeted.');
  const added = rerankMs(o, ctx, cat);
  // Only when this option is what breaks the target; an existing overrun is reported as a gap, not held against every reranker.
  if (added && ttftWithout !== null && ctx.ttftTargetMs !== null && ttftWithout <= ctx.ttftTargetMs && ttftWithout + added > ctx.ttftTargetMs) {
    v.conditions.push(`Adds ~${added.toLocaleString()} ms, taking time to first token to ~${(ttftWithout + added).toLocaleString()} ms against a ${ctx.ttftTargetMs.toLocaleString()} ms target.`);
  }
  if (o.id !== 'none') v.notes.push(`Reranks ${n} candidates down to top ${ctx.topK}.`);
  return v;
}

// ------------------------------------------------------------------- agent
export function agentStepsMs(o: AgentOption, ctx: RagAgentContext, cat: RagAgentCatalogue): number | null {
  if (ctx.ttftP95Ms === null) return null;
  return (o.maxSteps - 1) * (ctx.ttftP95Ms + cat.assumptions.latencyMs.toolCall);
}

export function evaluateAgent(o: AgentOption, ctx: RagAgentContext, cat: RagAgentCatalogue, e2eWithout: number | null): Verdict {
  const v = verdict();
  if (o.requiresToolCalling) {
    if (ctx.primary && !ctx.primary.toolCalling) v.failures.push(`Primary model ${ctx.primary.label} does not support tool calling - choose a tool-capable model in Model Selection.`);
    else if (!ctx.primary) v.conditions.push('No Model Selection yet - confirm the primary model supports tool calling.');
  } else {
    if (ctx.openEndedTasks) v.conditions.push('Tasks are open-ended - a fixed graph only covers the paths designed up front; unplanned requests fall through to a default answer.');
    if (ctx.primary && !ctx.primary.structuredOutput) {
      v.notes.push(`${ctx.primary.label} has no native structured output - use constrained decoding / JSON-schema validation between steps.`);
    }
  }
  if (o.id === 'multi_agent') {
    const order = cat.opsCapabilityOrder;
    if (order.indexOf(ctx.opsCapability) < order.indexOf(cat.agent.multiAgentMinOps)) {
      v.conditions.push(`Multi-agent systems need at least a ${cat.agent.multiAgentMinOps.replace(/_/g, ' ')} to trace, evaluate and debug (current: ${ctx.opsCapability.replace(/_/g, ' ')}).`);
    }
    if (ctx.toolAccess === 'external_actions' && ctx.businessCriticality && HIGH_CRITICALITY.includes(ctx.businessCriticality)) {
      v.conditions.push('Delegated external actions on a high-criticality workload - human approval on every external action and a task-level evaluation harness are required.');
    }
  }
  if (o.id === 'single_agent' && ctx.toolAccess === 'external_actions') v.notes.push('External actions from an autonomous loop - each goes through the human-approval gate below.');
  const steps = agentStepsMs(o, ctx, cat);
  if (steps !== null && e2eWithout !== null && ctx.e2eTargetMs !== null && e2eWithout <= ctx.e2eTargetMs && e2eWithout + steps > ctx.e2eTargetMs) {
    v.conditions.push(`Up to ${o.maxSteps} steps adds ~${steps.toLocaleString()} ms, taking a response to ~${(e2eWithout + steps).toLocaleString()} ms against a ${ctx.e2eTargetMs.toLocaleString()} ms target.`);
  }
  return v;
}

// ------------------------------------------------------------------ budgets
function contextBudget(ctx: RagAgentContext, agent: AgentOption | null, cat: RagAgentCatalogue): RagAgentResult['contextBudget'] {
  const t = cat.assumptions.tokens;
  const lines: Array<{ label: string; tokens: number; evidenceType: EvidenceType }> = [{ label: 'System prompt and instructions', tokens: t.systemPrompt, evidenceType: 'assumption' }];
  if (ctx.rag) {
    const chunk = ctx.chunkTokens ?? 512;
    lines.push({ label: `Retrieved context: top ${ctx.topK} × ~${chunk.toLocaleString()} tokens`, tokens: ctx.topK * chunk, evidenceType: ctx.chunkTokens === null ? 'assumption' : 'estimated' });
  }
  if (ctx.multiTurn) lines.push({ label: 'Conversation history (summarised beyond this)', tokens: t.conversationHistory, evidenceType: 'assumption' });
  if (agent) {
    lines.push({ label: 'Tool schemas', tokens: t.toolSchemas, evidenceType: 'assumption' });
    lines.push({ label: `Tool results: ${agent.maxSteps - 1} intermediate step(s)`, tokens: (agent.maxSteps - 1) * t.toolResultPerStep, evidenceType: 'assumption' });
  }
  lines.push({ label: 'Reserved for the answer', tokens: ctx.outputTokens, evidenceType: 'estimated' });
  const totalTokens = lines.reduce((s, l) => s + l.tokens, 0);
  const limitTokens = ctx.primary ? Math.floor(ctx.primary.contextWindow * cat.assumptions.maxContextUtilisation) : null;
  const fits = limitTokens === null ? null : totalTokens <= limitTokens;
  const note =
    limitTokens === null
      ? 'No Model Selection yet - the context window is unknown.'
      : fits
        ? `Fits ${ctx.primary!.label}: ${totalTokens.toLocaleString()} of ${limitTokens.toLocaleString()} usable tokens (${Math.round(cat.assumptions.maxContextUtilisation * 100)}% of ${ctx.primary!.contextWindow.toLocaleString()}).`
        : `Exceeds ${ctx.primary!.label}'s usable window: ${totalTokens.toLocaleString()} > ${limitTokens.toLocaleString()} tokens.`;
  return { lines, totalTokens, limitTokens, fits, note };
}

function latencyBudget(ctx: RagAgentContext, retrieval: RetrievalOption | null, rerank: RerankOption | null, agent: AgentOption | null, cat: RagAgentCatalogue): RagAgentResult['latencyBudget'] {
  const lines = retrievalMs(retrieval, ctx, cat);
  if (rerank && rerank.id !== 'none') {
    const ms = rerankMs(rerank, ctx, cat);
    if (ms !== null) lines.push({ stage: 'Reranking', ms, evidenceType: rerank.usesLlm ? 'estimated' : 'assumption', detail: `${rerank.label}, ${rerankCandidates(ctx, cat)} candidates` });
  }
  if (agent) {
    const ms = agentStepsMs(agent, ctx, cat);
    if (ms !== null && ms > 0) lines.push({ stage: 'Agent steps before the answer', ms, evidenceType: 'assumption', detail: `worst case: ${agent.maxSteps - 1} × (LLM TTFT + tool call)` });
  }
  lines.push({ stage: 'Prompt assembly', ms: cat.assumptions.latencyMs.promptAssembly, evidenceType: 'assumption', detail: 'dedupe, order, budget, template' });
  const llm = ctx.ttftP95Ms;
  if (llm !== null) lines.push({ stage: 'LLM time to first token (P95)', ms: llm, evidenceType: 'estimated', detail: 'Inference Architecture estimate' });
  const timeToFirstTokenMs = llm === null ? null : lines.reduce((s, l) => s + l.ms, 0);
  const generation = ctx.tpotMs === null ? null : Math.round(ctx.outputTokens * ctx.tpotMs);
  const endToEndMs = timeToFirstTokenMs === null || generation === null ? null : timeToFirstTokenMs + generation;
  if (generation !== null && timeToFirstTokenMs !== null) lines.push({ stage: 'Generation', ms: generation, evidenceType: 'estimated', detail: `${ctx.outputTokens.toLocaleString()} tokens × ${ctx.tpotMs} ms` });
  return {
    lines,
    timeToFirstTokenMs,
    ttftTargetMs: ctx.ttftTargetMs,
    meetsTtftTarget: timeToFirstTokenMs === null || ctx.ttftTargetMs === null ? null : timeToFirstTokenMs <= ctx.ttftTargetMs,
    endToEndMs,
    e2eTargetMs: ctx.e2eTargetMs,
    meetsE2eTarget: endToEndMs === null || ctx.e2eTargetMs === null ? null : endToEndMs <= ctx.e2eTargetMs,
  };
}

// --------------------------------------------------------------- sections
function ragSections(ctx: RagAgentContext, retrieval: RetrievalOption | null, rerank: RerankOption | null, cat: RagAgentCatalogue, gaps: string[]): NonNullable<RagAgentResult['rag']> {
  const filterable = ctx.metadataFields.filter((f) => f.filterable).map((f) => f.name);
  const searchable = ctx.metadataFields.filter((f) => f.searchable).map((f) => f.name);
  const sourceFields = ctx.metadataFields.filter((f) => SOURCE_FIELD.test(f.name)).map((f) => f.name);
  const acc = ctx.accuracyRequirement;

  const metadataFiltering: string[] = [];
  if (ctx.requiresMetadataFiltering || ctx.requiresTenantIsolation) {
    if (ctx.nativeFiltering === false) gaps.push(`${ctx.vectorPlatform} does not support metadata filtering, which this workload needs.`);
    metadataFiltering.push(filterable.length ? `Filterable fields from the pipeline: ${filterable.join(', ')}; filter before vector search (pre-filtering) so top-K is not emptied by post-filters.` : 'No filterable metadata fields in the Data Pipeline Design - define them before building the retriever.');
    if (!filterable.length) gaps.push('Metadata filtering is required but the pipeline defines no filterable fields.');
  } else {
    metadataFiltering.push(filterable.length ? `Not required by Discovery; ${filterable.join(', ')} are available for scoping queries.` : 'Not required by Discovery.');
  }
  if (ctx.requiresTenantIsolation) metadataFiltering.push("Tenant filter is mandatory and applied by the retriever from the caller's identity - never from the prompt or user input.");

  const citation: string[] = [];
  if (ctx.citationsRequired) {
    citation.push('Each chunk enters the prompt with a numbered marker and its source reference; the answer cites markers inline.');
    citation.push('Post-check: every cited marker must belong to a retrieved chunk - uncited factual sentences are flagged.');
    if (sourceFields.length) citation.push(`Source reference taken from pipeline metadata: ${sourceFields.join(', ')}.`);
    else {
      citation.push('No source / document identifier in the pipeline metadata - citations cannot point back to a document yet.');
      gaps.push('Citations are required but no source / document-id field exists in the Data Pipeline Design metadata.');
    }
  } else citation.push('Not required - answers are returned without source references.');

  const hallucinationMitigation = [
    'Instruct the model to answer only from the provided context and to say when the answer is not there.',
    'Low temperature for factual answers; refuse when retrieval returns nothing above the similarity threshold.',
  ];
  if (acc !== 'standard') hallucinationMitigation.push('Evaluation set with known answers run on every prompt, model or index change (faithfulness and answer relevance).');
  if (acc === 'critical') hallucinationMitigation.push('Groundedness check on every answer before it is returned; low-confidence answers go to human review.');

  return {
    semanticSearch: ctx.embeddingModel
      ? [`Queries embedded with ${ctx.embeddingModel} (${ctx.embeddingSelfHosted === false ? 'API' : 'self-hosted'}) - the same model and version as the documents; re-index on any embedding change.`, `Top ${ctx.topK} nearest chunks from ${ctx.vectorPlatform ?? 'the vector database'}.`]
      : ['No Data Pipeline Design yet - the embedding model is not fixed.'],
    hybridSearch: retrieval?.keyword
      ? [
          retrieval.extraComponent ? 'Dense results from the vector database and keyword results from the full-text index, fused with reciprocal-rank fusion.' : `Hybrid query in ${ctx.vectorPlatform ?? 'the vector database'}; tune the dense / keyword weighting on the evaluation set.`,
          searchable.length ? `Keyword fields: ${searchable.join(', ')}.` : 'No fields are marked searchable in the pipeline - mark title / body fields searchable for keyword matching.',
        ]
      : ['Not used - dense retrieval only.'],
    metadataFiltering,
    reranking: rerank && rerank.id !== 'none' ? [`${rerank.label}: ${rerankCandidates(ctx, cat)} candidates → top ${ctx.topK}.`, 'Keep the reranker version pinned alongside the embedding model.'] : ['Not used - candidates keep their retrieval order.'],
    contextConstruction: [
      'Deduplicate overlapping chunks and merge neighbours from the same document.',
      'Order by relevance and place the strongest passages first and last (long-context models attend less to the middle).',
      'Trim to the token budget below rather than truncating mid-passage.',
    ],
    promptConstruction: [
      'Versioned prompt templates in a registry, rolled out like code.',
      'Retrieved text is wrapped in delimited blocks and treated as untrusted data - instructions inside documents are ignored (prompt-injection defence).',
      ctx.primary?.structuredOutput ? `Structured output (JSON schema) from ${ctx.primary.label} where the application parses the answer.` : 'Validate any machine-read output against a schema.',
    ],
    citation,
    grounding: [
      'Answers are grounded only in retrieved passages; general-knowledge answers are either disabled or clearly labelled.',
      acc === 'critical' ? 'Answers failing the groundedness check are withheld.' : 'Groundedness is measured offline on the evaluation set.',
    ],
    hallucinationMitigation,
  };
}

function agentSections(ctx: RagAgentContext, agent: AgentOption | null, gaps: string[]): NonNullable<RagAgentResult['agent']> {
  const highCrit = !!ctx.businessCriticality && HIGH_CRITICALITY.includes(ctx.businessCriticality);
  const approval: Record<string, string> = {
    none: 'Not needed - the agent has no tools that act.',
    read_only: 'Not needed for read-only tools; log every tool call for review.',
    read_write: 'Approval before irreversible or bulk writes; routine writes are logged and reversible.',
    external_actions: 'Approval before every external action (payments, messages, tickets, changes in other systems).',
  };
  if (!ctx.policyEngine) gaps.push('No Inference Architecture yet - guardrails have no policy engine to run in.');
  return {
    orchestration: agent ? [`${agent.label}.`, `Bounded to ${agent.maxSteps} steps and a wall-clock timeout; on exhaustion return a partial answer with what was tried.`] : ['No usable orchestration pattern.'],
    toolCalling: [
      ctx.primary ? `${ctx.primary.label}: tool calling ${ctx.primary.toolCalling ? 'supported' : 'NOT supported'}, structured output ${ctx.primary.structuredOutput ? 'supported' : 'not native'}.` : 'Primary model not selected yet.',
      `Tool access: ${ctx.toolAccess.replace(/_/g, ' ')}. Arguments are validated against each tool's schema before execution.`,
      ...(ctx.toolAccess === 'read_write' || ctx.toolAccess === 'external_actions' ? ['Write tools take idempotency keys so retries never repeat an action.'] : []),
    ],
    memory: [
      ctx.multiTurn ? 'Short-term: the session transcript, summarised when it exceeds the history budget.' : 'Short-term: single request - no session state.',
      ctx.longTermMemory
        ? `Long-term: per-user memories in a separate ${ctx.vectorPlatform ?? 'vector database'} collection, always filtered by user id, with retention and deletion on request${ctx.containsPii ? ' and PII redaction before storage' : ''}.`
        : 'Long-term: none - nothing is remembered across sessions.',
    ],
    planning: [
      agent?.id === 'workflow_graph'
        ? 'Fixed plan: the graph defines the steps; the model fills in each step.'
        : agent?.id === 'multi_agent'
          ? 'The supervisor decomposes the task and delegates to specialists; each specialist has its own tool subset.'
          : 'Reason-act loop: the model chooses the next tool until it can answer or hits the step limit.',
    ],
    guardrails: [
      ctx.policyEngine ? "Enforced in the Inference Architecture's gateway policy engine (input and output)." : 'Needs a policy engine - design the Inference Architecture.',
      `Input: prompt-injection detection on user input and on tool results${ctx.containsPii ? '; PII detection and masking' : ''}.`,
      'Output: content policy and data-leakage checks before anything reaches the user or a tool.',
    ],
    humanApproval: [approval[ctx.toolAccess], ...(highCrit && ctx.toolAccess !== 'none' ? ['High business criticality: approvals are recorded with approver and reason.'] : [])],
    toolSecurity: [
      'Explicit tool allow-list per agent; no dynamic tool discovery in production.',
      "Least privilege: each tool runs with its own scoped identity or the user's delegated (on-behalf-of) token - never a shared admin credential.",
      'Rate limits and spend limits per tool; every call audited with inputs, outputs and caller.',
    ],
    isolation: [
      'Code or shell tools run in a sandbox with no network by default and an egress allow-list when needed.',
      ...(ctx.requiresTenantIsolation ? ['Per-tenant isolation: tools, memory and retrieval scoped to the caller’s tenant.'] : []),
      ...(ctx.restrictedData ? ['Restricted data: every tool and model an agent can reach must be inside the customer boundary.'] : []),
    ],
  };
}

/**
 * GenAI Application Architecture (spec §10): retrieval strategy, reranking and
 * agent orchestration are each chosen eligibility-first then by score; the
 * rest of RAG and agent design is derived, with context and latency budgets.
 * Pure.
 */
export function designRagAgent(ctx: RagAgentContext, cat: RagAgentCatalogue): RagAgentResult {
  const decisions: AreaDecision[] = [];
  const gaps: string[] = [];
  const accuracyUp = ctx.accuracyRequirement !== 'standard';
  const latencyUp = ctx.latencyPriority === 'high';

  let retrieval: RetrievalOption | null = null;
  let rerank: RerankOption | null = null;
  if (ctx.rag) {
    const w = weightsFor(cat.retrieval.weights, [...(accuracyUp ? ['relevance' as const] : []), ...(latencyUp ? ['latency' as const] : [])], cat.priorityMultiplier);
    const r = decide(
      'retrieval',
      'Retrieval strategy',
      cat.retrieval.options.map((o) => {
        const v = evaluateRetrieval(o, ctx);
        return { area: 'retrieval', id: o.id, label: o.label, eligibility: eligibilityOf(v), ...v, score: score(o as unknown as Record<string, number>, w) };
      }),
    );
    decisions.push(r);
    retrieval = cat.retrieval.options.find((o) => o.id === r.chosen?.id) ?? null;

    const ttftWithout = ctx.ttftP95Ms === null ? null : retrievalMs(retrieval, ctx, cat).reduce((s, l) => s + l.ms, 0) + cat.assumptions.latencyMs.promptAssembly + ctx.ttftP95Ms;
    const wr = weightsFor(cat.reranking.weights, [...(accuracyUp ? ['relevance' as const] : []), ...(latencyUp ? ['latency' as const] : [])], cat.priorityMultiplier);
    const k = decide(
      'reranking',
      'Reranking',
      cat.reranking.options.map((o) => {
        const v = evaluateRerank(o, ctx, cat, ttftWithout);
        return { area: 'reranking', id: o.id, label: o.label, eligibility: eligibilityOf(v), ...v, score: score(o as unknown as Record<string, number>, wr) };
      }),
    );
    decisions.push(k);
    rerank = cat.reranking.options.find((o) => o.id === k.chosen?.id) ?? null;
    if (ctx.vectorPlatform === null) gaps.push('No Vector DB decision yet - retrieval is designed against Discovery requirements only.');
    if (ctx.chunkTokens === null) gaps.push('No Data Pipeline Design yet - chunk size assumed 512 tokens.');
  }

  let agent: AgentOption | null = null;
  if (ctx.agent) {
    const highCrit = !!ctx.businessCriticality && HIGH_CRITICALITY.includes(ctx.businessCriticality);
    const w = weightsFor(cat.agent.weights, [...(accuracyUp || highCrit ? ['controllability' as const] : []), ...(latencyUp ? ['latency' as const] : [])], cat.priorityMultiplier);
    const pre = latencyBudget(ctx, retrieval, rerank, null, cat);
    const a = decide(
      'agent',
      'Agent orchestration',
      cat.agent.options.map((o) => {
        const v = evaluateAgent(o, ctx, cat, pre.endToEndMs);
        return { area: 'agent', id: o.id, label: o.label, eligibility: eligibilityOf(v), ...v, score: score(o as unknown as Record<string, number>, w) };
      }),
    );
    decisions.push(a);
    agent = cat.agent.options.find((o) => o.id === a.chosen?.id) ?? null;
  }
  if (!ctx.primary) gaps.push('No Model Selection yet - context window and tool calling are unknown.');
  if (ctx.ttftP95Ms === null) gaps.push('No Inference Architecture latency estimate yet - the latency budget has no LLM figure.');

  const context = contextBudget(ctx, agent, cat);
  if (context.fits === false) {
    const over = context.totalTokens - context.limitTokens!;
    const perChunk = ctx.chunkTokens ?? 512;
    gaps.push(`${context.note} Reduce top-K by ~${Math.ceil(over / perChunk)}, compress context, or choose a longer-context model.`);
  }
  const latency = latencyBudget(ctx, retrieval, rerank, agent, cat);
  if (latency.meetsTtftTarget === false) gaps.push(`Estimated time to first token ~${latency.timeToFirstTokenMs!.toLocaleString()} ms exceeds the ${latency.ttftTargetMs!.toLocaleString()} ms target.`);
  if (latency.meetsE2eTarget === false) gaps.push(`Estimated end-to-end ~${latency.endToEndMs!.toLocaleString()} ms exceeds the ${latency.e2eTargetMs!.toLocaleString()} ms target - stream the answer or reduce steps / candidates.`);

  const rag = ctx.rag ? ragSections(ctx, retrieval, rerank, cat, gaps) : null;
  const agentOut = ctx.agent ? agentSections(ctx, agent, gaps) : null;

  const components: RagAgentResult['components'] = [
    { layer: 'Users', component: 'AI application', detail: ctx.multiTurn ? 'conversational' : 'single request' },
    { layer: 'Gateway', component: 'API / AI gateway', detail: ctx.policyEngine ? 'with policy engine (Inference Architecture)' : 'not designed yet' },
  ];
  if (ctx.rag) {
    components.push({ layer: 'RAG engine', component: retrieval?.label ?? 'no retrieval strategy', detail: `${ctx.vectorPlatform ?? 'vector DB not chosen'}${retrieval?.extraComponent ? ' + keyword index' : ''}` });
    components.push({ layer: 'Embedding service', component: ctx.embeddingModel ?? 'not chosen', detail: ctx.embeddingSelfHosted === false ? 'API' : 'self-hosted' });
    if (rerank && rerank.id !== 'none') components.push({ layer: 'Reranker', component: rerank.label, detail: `${rerankCandidates(ctx, cat)} → ${ctx.topK}` });
  }
  if (ctx.agent) components.push({ layer: 'Agent engine', component: agent?.label ?? 'no usable pattern', detail: `tool layer: ${ctx.toolAccess.replace(/_/g, ' ')}` });
  components.push({ layer: 'Inference', component: ctx.primary?.label ?? 'model not selected', detail: ctx.fallback ? `fallback ${ctx.fallback.label}` : 'via the model router' });

  const chosen = decisions.map((d) => d.chosen);
  const confidence: RagAgentResult['confidence'] = chosen.some((c) => !c) ? 'low' : chosen.some((c) => c!.eligibility === 'conditional') || gaps.length ? 'medium' : 'high';

  const wouldChangeIf: string[] = [];
  if (ctx.rag && retrieval?.id === 'hybrid_native') wouldChangeIf.push('A vector database without native hybrid search would move retrieval to a separate keyword index with application-side fusion.');
  if (ctx.rag && retrieval?.id === 'semantic') wouldChangeIf.push('Requiring hybrid or full-text search in Discovery would make dense-only retrieval ineligible.');
  if (ctx.rag && rerank?.id === 'none') wouldChangeIf.push('Requiring reranking, or a higher accuracy requirement, would add a reranker.');
  if (ctx.rag && rerank?.external) wouldChangeIf.push('Restricting deployment to on-premises or disallowing third-party APIs would move reranking in-house.');
  if (ctx.agent) wouldChangeIf.push('A primary model without tool calling leaves only the deterministic workflow pattern.');
  if (ctx.agent && agent?.id === 'workflow_graph') wouldChangeIf.push('Open-ended tasks (an input on this page) make the fixed workflow conditional and favour a tool-calling agent.');
  if (ctx.agent && agent?.id !== 'multi_agent') wouldChangeIf.push('A supervisor with sub-agents needs tool calling and at least a dedicated operations team; it ranks lower on controllability and latency.');

  const benchmarkRequired: string[] = [];
  if (ctx.rag) {
    benchmarkRequired.push(`Retrieval quality on a labelled evaluation set: recall@${ctx.topK}${ctx.precisionTarget !== null ? `, precision (target ${ctx.precisionTarget})` : ''}, nDCG / MRR.`);
    if (rerank && rerank.id !== 'none') benchmarkRequired.push(`Reranker latency at ${rerankCandidates(ctx, cat)} candidates under peak concurrency, and its quality gain over no reranking.`);
    benchmarkRequired.push('Answer faithfulness and hallucination rate on the evaluation set.');
  }
  if (ctx.agent) {
    benchmarkRequired.push('Agent task success rate, average and worst-case steps, and cost per task on representative tasks.');
    benchmarkRequired.push('Red-team: prompt injection through retrieved documents and tool results, and tool misuse.');
  }
  benchmarkRequired.push('End-to-end time to first token and response time at peak load, replacing the assumptions in the latency budget.');

  const parts = [ctx.rag ? 'RAG' : null, ctx.agent ? 'agent' : null].filter(Boolean).join(' + ');
  const summary = [
    ctx.rag && retrieval ? retrieval.label : null,
    ctx.rag && rerank ? (rerank.id === 'none' ? 'no reranking' : rerank.label) : null,
    ctx.agent && agent ? agent.label : null,
  ]
    .filter(Boolean)
    .join('; ');

  return {
    rulesVersion: cat.rulesVersion,
    scope: { rag: ctx.rag, agent: ctx.agent, summary: `${parts}: ${summary || 'no usable design'}` },
    decisions,
    confidence,
    rag,
    agent: agentOut,
    contextBudget: context,
    latencyBudget: latency,
    components,
    gaps,
    wouldChangeIf,
    benchmarkRequired,
  };
}
