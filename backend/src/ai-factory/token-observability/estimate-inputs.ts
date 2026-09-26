import { DEFAULT_KNOBS } from './token-estimate.engine';
import { EstimateContext, EstimateKnobs, InputProvenance, LlmUsage, ResolvedInput } from './token-observability.types';

/**
 * Estimation inputs with provenance (Token Observability validation spec §1,
 * §3, §17). Every input resolves, in this order, to:
 *   User Override   - saved with the estimate; a later pattern never replaces it
 *   Calculated      - from another phase of this project (Inference, RAG / agent
 *                     design, Discovery) or a documented platform default
 *   Pattern Default - from the project's AI Factory pattern
 *   Not configured  - nothing supplies it; no value is invented
 * Pure: the caller supplies the records.
 */

/** Optional token metadata on a pattern (config/patterns.yaml). Only what the pattern can honestly say. */
export interface PatternTokenProfile {
  workloadType: 'rag' | 'agent' | 'search' | 'recommendation' | 'multimodal_search';
  llmUsage: LlmUsage;
  llmRequestSharePercent?: number | null;
  llmCallsPerRequest?: number | null;
  agentStepsPerRequest?: number | null;
  guidance: string[];
}

export interface PatternRef {
  id: string;
  name: string;
  /** Search QPS the pattern seeds into Discovery. */
  qps: number | null;
  profile: PatternTokenProfile | null;
}

/** What a user may override (all optional; absent = not overridden). */
export interface EstimateOverrides {
  llmUsage?: LlmUsage;
  requestsPerDay?: number;
  qps?: number;
  utilizationPercent?: number;
  operatingDaysPerMonth?: number;
  llmRequestSharePercent?: number;
  avgInputTokensPerRequest?: number;
  avgOutputTokensPerRequest?: number;
  systemPromptTokens?: number;
  conversationHistoryTokens?: number;
  retrievedContextTokens?: number;
  queryTokens?: number;
  embeddingTokensPerRequest?: number;
  rerankingTokensPerRequest?: number;
  llmCallsPerRequest?: number;
  agentStepsPerRequest?: number;
  retryRatePercent?: number;
  cacheHitRatePercent?: number;
}

export interface InputSources {
  pattern: PatternRef | null;
  discovery: { version: number; qps: number } | null;
  inference: { version: number; requestsPerMonth: number; avgInputTokens: number; avgOutputTokens: number } | null;
  operatingDaysPerMonth: number;
}

type Candidate<T extends number | string> = { value: T | null | undefined; provenance: InputProvenance; source: string };

/** First candidate with a value; otherwise Not configured. */
function pick<T extends number | string>(key: string, label: string, unit: string, candidates: Array<Candidate<T>>): ResolvedInput & { value: T | null } {
  for (const c of candidates) {
    if (c.value !== null && c.value !== undefined) return { key, label, unit, value: c.value, provenance: c.provenance, source: c.source };
  }
  return { key, label, unit, value: null, provenance: 'not_configured', source: 'Not configured' };
}

const override = <T extends number | string>(v: T | undefined): Candidate<T> => ({ value: v, provenance: 'user_override', source: 'User override' });

export function applyInputs(base: EstimateContext, overrides: EstimateOverrides, src: InputSources): { context: EstimateContext; inputs: ResolvedInput[] } {
  const o = overrides;
  const p = src.pattern;
  const prof = p?.profile ?? null;
  const patternSource = p ? `Pattern: ${p.name}` : '';
  const d = base.design;
  const gaps = [...base.gaps];
  const inputs: ResolvedInput[] = [];
  const add = <T extends number | string>(r: ResolvedInput & { value: T | null }) => {
    inputs.push(r);
    return r.value;
  };

  // ------------------------------------------------------------ LLM usage
  const llmUsage = (add(
    pick<LlmUsage>('llmUsage', 'LLM usage', '', [
      override(o.llmUsage),
      { value: prof?.llmUsage, provenance: 'pattern_default', source: patternSource },
      { value: 'required', provenance: 'calculated', source: 'Assumed: every request calls an LLM (no pattern or override says otherwise)' },
    ]),
  ) ?? 'required') as LlmUsage;

  // -------------------------------------------------------------- traffic
  const qps = add(
    pick<number>('qps', 'Search / request QPS (average)', 'req/s', [
      override(o.qps),
      { value: src.discovery?.qps, provenance: 'calculated', source: src.discovery ? `Discovery v${src.discovery.version}` : '' },
      { value: p?.qps, provenance: 'pattern_default', source: patternSource },
    ]),
  );
  // Never assume the workload runs flat out: utilization only comes from the user.
  const utilization = add(pick<number>('utilizationPercent', 'Utilization of that QPS', '%', [override(o.utilizationPercent)]));
  const fromQps = qps !== null && utilization !== null ? Math.round(qps * 86_400 * (utilization / 100)) : null;
  const requestsPerDay = add(
    pick<number>('requestsPerDay', 'Requests per day', 'req/day', [
      override(o.requestsPerDay),
      // QPS or utilization the user set wins over the Inference volume.
      { value: o.qps !== undefined || o.utilizationPercent !== undefined ? fromQps : null, provenance: 'calculated', source: 'QPS × 86,400 × utilization' },
      { value: src.inference ? Math.round(src.inference.requestsPerMonth / src.operatingDaysPerMonth) : null, provenance: 'calculated', source: src.inference ? `Inference assessment v${src.inference.version}` : '' },
      { value: fromQps, provenance: 'calculated', source: 'QPS × 86,400 × utilization' },
    ]),
  );
  const operatingDays =
    add(
      pick<number>('operatingDaysPerMonth', 'Operating days per month', 'days', [
        override(o.operatingDaysPerMonth),
        { value: src.operatingDaysPerMonth, provenance: 'calculated', source: 'Platform default (token-observability.yaml)' },
      ]),
    ) ?? DEFAULT_KNOBS.operatingDaysPerMonth;
  if (requestsPerDay === null) gaps.push('No request volume: set requests per day, or QPS and utilization (utilization is never assumed).');

  // ------------------------------------------------ share of requests on the LLM
  const share = add(
    pick<number>('llmRequestSharePercent', 'Requests that call the LLM', '%', [
      override(o.llmRequestSharePercent),
      { value: llmUsage === 'none' ? 0 : null, provenance: 'calculated', source: 'No LLM (vector-only)' },
      { value: prof?.llmRequestSharePercent, provenance: 'pattern_default', source: patternSource },
      { value: llmUsage === 'required' ? 100 : null, provenance: 'calculated', source: 'Every request calls the LLM' },
    ]),
  );
  if (llmUsage === 'optional' && share === null) gaps.push('LLM usage is optional for this workload: set the share of requests that call the LLM - search QPS is not LLM QPS.');

  // ------------------------------------------------------------ prompt make-up
  const inf = src.inference;
  const infSource = inf ? `Inference assessment v${inf.version}` : '';
  const dSource = d?.source ?? '';
  const avgInput = add(pick<number>('avgInputTokensPerRequest', 'Input tokens per LLM call (whole prompt)', 'tokens', [override(o.avgInputTokensPerRequest), { value: inf?.avgInputTokens, provenance: 'calculated', source: infSource }]));
  const avgOutput = add(pick<number>('avgOutputTokensPerRequest', 'Output tokens per answer', 'tokens', [override(o.avgOutputTokensPerRequest), { value: inf?.avgOutputTokens, provenance: 'calculated', source: infSource }]));
  const systemPrompt = add(pick<number>('systemPromptTokens', 'System prompt tokens', 'tokens', [override(o.systemPromptTokens), { value: d?.systemPromptTokens, provenance: 'calculated', source: dSource }]));
  const history = add(pick<number>('conversationHistoryTokens', 'Conversation history tokens', 'tokens', [override(o.conversationHistoryTokens), { value: d?.historyTokens, provenance: 'calculated', source: dSource }]));
  const designRetrieved = d && base.scope.rag ? d.topK * d.chunkTokens : null;
  const retrieved = add(
    pick<number>('retrievedContextTokens', 'Retrieved context tokens', 'tokens', [override(o.retrievedContextTokens), { value: designRetrieved, provenance: 'calculated', source: d ? `${dSource}: top ${d.topK} × ${d.chunkTokens} tokens` : '' }]),
  );
  const queryTokens =
    add(pick<number>('queryTokens', 'User query tokens', 'tokens', [override(o.queryTokens), { value: base.queryTokens, provenance: 'calculated', source: 'finops.yaml embedding.avgQueryTokens' }])) ?? base.queryTokens;
  const embedding = add(
    pick<number>('embeddingTokensPerRequest', 'Embedding tokens per request', 'tokens', [override(o.embeddingTokensPerRequest), { value: base.scope.rag ? queryTokens : null, provenance: 'calculated', source: 'The query is embedded once' }]),
  );
  const designRerank = d?.rerank ? d.rerank.candidates * (queryTokens + d.chunkTokens) : d ? 0 : null;
  const reranking = add(
    pick<number>('rerankingTokensPerRequest', 'Reranking tokens per request', 'tokens', [override(o.rerankingTokensPerRequest), { value: designRerank, provenance: 'calculated', source: d?.rerank ? `${dSource}: ${d.rerank.label}` : dSource ? `${dSource}: no reranker` : '' }]),
  );

  // ---------------------------------------------------------------- calls
  const designSteps = d?.agent ? d.agent.maxSteps : null;
  const agentSteps = add(
    pick<number>('agentStepsPerRequest', 'Agent steps per task', 'steps', [override(o.agentStepsPerRequest), { value: designSteps, provenance: 'calculated', source: dSource }, { value: prof?.agentStepsPerRequest, provenance: 'pattern_default', source: patternSource }]),
  );
  const llmCalls = add(
    pick<number>('llmCallsPerRequest', 'LLM calls per request', 'calls', [
      override(o.llmCallsPerRequest),
      { value: agentSteps, provenance: 'calculated', source: 'One call per agent step' },
      { value: llmUsage === 'none' ? 0 : null, provenance: 'calculated', source: 'No LLM (vector-only)' },
      { value: prof?.llmCallsPerRequest, provenance: 'pattern_default', source: patternSource },
    ]),
  );
  const retryRate = add(pick<number>('retryRatePercent', 'Retry rate', '%', [override(o.retryRatePercent)]));
  const cacheHit = add(pick<number>('cacheHitRatePercent', 'Provider cache hit rate', '%', [override(o.cacheHitRatePercent)]));

  // ------------------------------------------------------------ apply to the context
  const ctx: EstimateContext = { ...base, gaps, queryTokens };
  if (requestsPerDay !== null) {
    const rpd = inputs.find((i) => i.key === 'requestsPerDay')!;
    const rpdSource = rpd.source;
    const infSourceLabel = src.inference ? `Inference assessment v${src.inference.version}` : null;
    // Keep the Inference month exact unless the user changed the day count or volume.
    const exact = rpdSource === infSourceLabel && o.operatingDaysPerMonth === undefined;
    ctx.requestsPerMonth = exact ? src.inference!.requestsPerMonth : Math.round(requestsPerDay * operatingDays);
    ctx.requestsSource = `${requestsPerDay.toLocaleString()} requests / day (${rpd.source}) × ${operatingDays} days`;
  } else {
    ctx.requestsPerMonth = 0;
    ctx.requestsSource = null;
  }
  if (base.llm) ctx.llm = { ...base.llm, avgInputTokens: avgInput ?? base.llm.avgInputTokens, avgOutputTokens: avgOutput ?? 0 };
  else if (avgInput !== null || avgOutput !== null) {
    // No Inference assessment: the user described the prompt directly - it cannot be priced until a model is chosen.
    ctx.llm = { avgInputTokens: avgInput ?? 0, avgOutputTokens: avgOutput ?? 0, provider: 'unconfigured', model: 'unconfigured', label: 'model not chosen', selfHosted: null, assessedPrices: null, source: 'User override' };
  }
  if (d) {
    ctx.design = {
      ...d,
      systemPromptTokens: systemPrompt ?? d.systemPromptTokens,
      historyTokens: history ?? d.historyTokens,
      ...(o.retrievedContextTokens !== undefined ? { retrievedContextTokens: o.retrievedContextTokens } : {}),
      agent: d.agent && agentSteps !== null ? { ...d.agent, maxSteps: Math.max(1, Math.round(agentSteps)) } : d.agent,
    };
  }
  // Scope from the pattern only when no phase has said anything yet.
  if (base.scope.source === 'not yet known' && prof) {
    ctx.scope = { rag: prof.workloadType === 'rag', agent: prof.workloadType === 'agent', source: patternSource };
  }
  const knobs: EstimateKnobs = {
    llmUsage,
    // An optional LLM with no share configured projects no LLM tokens rather than guessing a share.
    llmRequestSharePercent: share ?? (llmUsage === 'optional' ? 0 : 100),
    llmCallsPerRequest: llmCalls ?? 1,
    retryRatePercent: retryRate ?? 0,
    cacheHitRatePercent: cacheHit ?? 0,
    operatingDaysPerMonth: operatingDays,
    ...(o.embeddingTokensPerRequest !== undefined ? { embeddingTokensPerRequest: embedding ?? undefined } : {}),
    ...(o.rerankingTokensPerRequest !== undefined ? { rerankingTokensPerRequest: reranking ?? undefined } : {}),
  };
  ctx.knobs = knobs;
  // Inputs the calculation derived (shown, not editable here).
  inputs.push({ key: 'toolCallsPerRequest', label: 'Tool calls per task', unit: 'calls', value: agentSteps !== null ? Math.max(0, Math.round(agentSteps) - 1) : null, provenance: agentSteps !== null ? 'calculated' : 'not_configured', source: agentSteps !== null ? 'Agent steps - 1' : 'Not configured' });
  return { context: ctx, inputs };
}

