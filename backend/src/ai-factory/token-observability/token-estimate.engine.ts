import { costOf, PriceRow, PricingTreatment } from './pricing';
import { CostLine, EstimateContext, EstimateKnobs, TokenEstimateResult, TokenLine, TokenObservabilityCatalogue } from './token-observability.types';

export const DEFAULT_KNOBS: EstimateKnobs = { llmUsage: 'required', llmRequestSharePercent: 100, llmCallsPerRequest: 1, retryRatePercent: 0, cacheHitRatePercent: 0, operatingDaysPerMonth: 30.4 };

/**
 * Estimated-mode token and cost projection (spec §8, §9, §12, §13). Pure: the
 * resolved context, the price rows and the moment to price at. Every figure is
 * labelled estimated or assumption - nothing here is observed usage.
 */
export function estimateTokens(
  ctx: EstimateContext,
  prices: PriceRow[],
  cat: Pick<TokenObservabilityCatalogue, 'rulesVersion' | 'estimation'> & { pricing: Pick<PricingTreatment, 'cachedInputPriceFactor' | 'reasoningBilledAs'> },
  at: Date,
  projectId: string,
): TokenEstimateResult {
  const q = ctx.queryTokens;
  const answer = ctx.llm?.avgOutputTokens ?? 0;
  const d = ctx.design;
  const rag = ctx.scope.rag && !!d;
  const agent = ctx.scope.agent && d?.agent ? d.agent : null;
  const assumptions: string[] = [];
  const gaps = [...ctx.gaps];
  const k: EstimateKnobs = { ...DEFAULT_KNOBS, ...ctx.knobs };
  // Vector-only workloads (e.g. a recommendation engine) search without calling an LLM.
  const llmOn = k.llmUsage !== 'none';
  const share = llmOn ? Math.min(100, Math.max(0, k.llmRequestSharePercent)) / 100 : 0;
  const retry = 1 + Math.max(0, k.retryRatePercent) / 100;
  const cacheShare = Math.min(100, Math.max(0, k.cacheHitRatePercent)) / 100;

  // ------------------------------------------------ final LLM call make-up
  const retrieved = rag ? (d!.retrievedContextTokens ?? d!.topK * d!.chunkTokens) : 0;
  const steps = agent ? Math.max(1, Math.round(agent.maxSteps * cat.estimation.agentStepsShareOfMax)) : 1;
  const input: TokenLine[] = [];
  if (llmOn && d) {
    input.push({ label: 'System prompt and instructions', tokens: d.systemPromptTokens, evidenceType: 'assumption', source: d.source });
    input.push({ label: 'User query', tokens: q, evidenceType: 'assumption', source: 'finops.yaml embedding.avgQueryTokens' });
    if (rag) input.push({ label: d.retrievedContextTokens !== undefined ? 'Retrieved context (override)' : `Retrieved context: top ${d.topK} × ~${d.chunkTokens.toLocaleString()} tokens`, tokens: retrieved, evidenceType: d.chunkAssumed ? 'assumption' : 'estimated', source: d.source });
    if (d.historyTokens) input.push({ label: 'Conversation history', tokens: d.historyTokens, evidenceType: 'assumption', source: d.source });
    if (agent) {
      input.push({ label: 'Tool schemas', tokens: agent.toolSchemaTokens, evidenceType: 'assumption', source: d.source });
      if (steps > 1) input.push({ label: `Tool results from ${steps - 1} earlier step(s)`, tokens: (steps - 1) * agent.toolResultPerStep, evidenceType: 'assumption', source: d.source });
    }
  } else if (llmOn && ctx.llm) {
    input.push({ label: ctx.llm.assessedPrices ? 'Prompt (whole, as sized in the Inference assessment)' : 'Prompt (whole)', tokens: ctx.llm.avgInputTokens, evidenceType: 'estimated', source: ctx.llm.source });
  }
  const finalInput = sum(input.map((l) => l.tokens));

  // --------------------------------------------------- every LLM call
  // Each agent step re-sends the prompt plus the tool results gathered so far.
  const base = finalInput - (agent && steps > 1 ? (steps - 1) * agent.toolResultPerStep : 0);
  // Agents: one call per step. Other workflows: llmCallsPerRequest calls (1 unless a chain is configured).
  const nCalls = !llmOn || !(ctx.llm || d) ? 0 : agent ? steps : Math.max(1, Math.round(k.llmCallsPerRequest));
  const calls = Array.from({ length: nCalls }, (_, i) => ({
    step: agent ? (i < steps - 1 ? `Step ${i + 1}: choose and call a tool` : `Step ${steps}: answer`) : nCalls > 1 ? `Call ${i + 1}` : 'Answer',
    inputTokens: base + (agent ? i * agent.toolResultPerStep : 0),
    outputTokens: agent && i < steps - 1 ? cat.estimation.toolCallOutputTokens : answer,
  }));
  // Retries re-send whole calls, so they add to both sides.
  const inputTokens = Math.round(sum(calls.map((c) => c.inputTokens)) * retry);
  const outputTokens = Math.round(sum(calls.map((c) => c.outputTokens)) * retry);

  // ----------------------------------------------- retrieval and reranking
  const rerank = rag ? d!.rerank : null;
  const rerankingTokens = k.rerankingTokensPerRequest ?? (rerank ? rerank.candidates * (q + d!.chunkTokens) : 0);
  const queryEmbeddingTokens = k.embeddingTokensPerRequest ?? (rag ? q : 0);

  // --------------------------------------------------------------- monthly
  const n = ctx.requestsPerMonth;
  const monthlyEmbedding = n * queryEmbeddingTokens + (ctx.embedding?.monthlyNewDocumentTokens ?? 0);
  // Search / retrieval happens for every request; only a share of them may call the LLM.
  const llmRequests = Math.round(n * share);
  const monthly = {
    requests: n,
    inputTokens: llmRequests * inputTokens,
    outputTokens: llmRequests * outputTokens,
    totalTokens: llmRequests * (inputTokens + outputTokens),
    embeddingTokens: monthlyEmbedding,
    rerankingTokens: n * rerankingTokens,
    basis: ctx.requestsSource
      ? `${n.toLocaleString()} requests / month (${ctx.requestsSource})${ctx.embedding?.monthlyNewDocumentTokens ? `; embedding includes ${ctx.embedding.monthlyNewDocumentTokens.toLocaleString()} new-document tokens / month` : ''}`
      : 'No request volume yet - run the Inference assessment.',
  };

  // ------------------------------------------------------------------ cost
  const lines: CostLine[] = [];
  let llmMonthlyUsd: number | null = null;
  if (llmOn && ctx.llm?.selfHosted) {
    const perM = monthly.totalTokens ? ctx.llm.selfHosted.monthlyUsd / (monthly.totalTokens / 1e6) : null;
    llmMonthlyUsd = ctx.llm.selfHosted.monthlyUsd;
    lines.push({ item: `LLM serving (self-hosted, ${ctx.llm.selfHosted.label})`, tokens: monthly.totalTokens, pricePer1M: perM === null ? null : round(perM, 4), usd: round(llmMonthlyUsd, 2), price: `GPU capacity cost from ${ctx.llm.source} - not a token price`, evidenceType: 'estimated' });
  } else if (llmOn && ctx.llm) {
    const c = costOf(prices, ctx.llm.provider, ctx.llm.model, { input: monthly.inputTokens, output: monthly.outputTokens, cachedInput: Math.round(monthly.inputTokens * cacheShare) }, at, projectId, cat.pricing);
    for (const type of ['input', 'output'] as const) {
      const ref = c.refs.find((r) => r.tokenType === type);
      const usd = type === 'input' ? c.inputCost : c.outputCost;
      lines.push({
        item: `LLM ${type} tokens (${ctx.llm.label})`,
        tokens: type === 'input' ? monthly.inputTokens : monthly.outputTokens,
        pricePer1M: ref?.pricePer1M ?? null,
        usd: ref && usd !== null ? round(usd, 2) : null,
        price: ref ? `${ctx.llm.provider} / ${ctx.llm.model} ${type} @ ${ref.effectiveFrom.slice(0, 10)}` : `No ${type} price for ${ctx.llm.provider} / ${ctx.llm.model}`,
        evidenceType: 'estimated',
      });
    }
    llmMonthlyUsd = c.refs.length ? c.totalCost : null;
    const a = ctx.llm.assessedPrices;
    const inRef = c.refs.find((r) => r.tokenType === 'input');
    const outRef = c.refs.find((r) => r.tokenType === 'output');
    if (a && inRef && outRef && (a.inputPer1M !== inRef.pricePer1M || a.outputPer1M !== outRef.pricePer1M)) {
      assumptions.push(
        `The Inference assessment used $${a.inputPer1M} / $${a.outputPer1M} per 1M input / output tokens; the price table has $${inRef.pricePer1M} / $${outRef.pricePer1M}. Add the contracted price as a project price to use it here.`,
      );
    }
  }
  if (ctx.embedding && monthlyEmbedding > 0) {
    const c = costOf(prices, ctx.embedding.provider, ctx.embedding.model, { input: 0, output: 0, embedding: monthlyEmbedding }, at, projectId, cat.pricing);
    const ref = c.refs[0];
    lines.push({ item: `Embedding tokens (${ctx.embedding.model})`, tokens: monthlyEmbedding, pricePer1M: ref?.pricePer1M ?? null, usd: ref && c.totalCost !== null ? round(c.totalCost, 2) : null, price: ref ? `${ctx.embedding.provider} / ${ctx.embedding.model} embedding @ ${ref.effectiveFrom.slice(0, 10)}` : `No embedding price for ${ctx.embedding.provider} / ${ctx.embedding.model}`, evidenceType: 'estimated' });
  }
  if (rerank && monthly.rerankingTokens > 0) {
    const c = costOf(prices, 'reranker', rerank.id, { input: 0, output: 0, reranking: monthly.rerankingTokens }, at, projectId, cat.pricing);
    const ref = c.refs[0];
    lines.push({ item: `Reranking tokens (${rerank.label})`, tokens: monthly.rerankingTokens, pricePer1M: ref?.pricePer1M ?? null, usd: ref && c.totalCost !== null ? round(c.totalCost, 2) : null, price: ref ? `reranker / ${rerank.id} @ ${ref.effectiveFrom.slice(0, 10)}` : `No reranking price for reranker / ${rerank.id}`, evidenceType: 'estimated' });
  }
  const priced = lines.filter((l) => l.usd !== null);
  const unpriced = lines.filter((l) => l.usd === null);
  const monthlyUsd = priced.length ? round(sum(priced.map((l) => l.usd!)), 2) : null;
  const perRequestUsd = monthlyUsd !== null && n > 0 ? round(monthlyUsd / n, 6) : null;
  const note = [
    'Estimated from the design - not a quote and not observed spend.',
    unpriced.length ? `Not priced (no price in force): ${unpriced.map((l) => l.item).join('; ')}. The total excludes them.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  // --------------------------------------------------------------- budget
  const shareOfBudget = ctx.budget && monthlyUsd !== null && ctx.budget.monthlyUsd > 0 ? round(monthlyUsd / ctx.budget.monthlyUsd, 4) : null;

  // ---------------------------------------------------------- assumptions
  if (!d && ctx.llm?.assessedPrices) assumptions.push('No RAG / agent design yet: the prompt is taken whole from the Inference assessment, so context make-up is not broken down.');
  if (d && ctx.llm?.assessedPrices && ctx.llm.avgInputTokens > 0 && Math.abs(finalInput - ctx.llm.avgInputTokens) / ctx.llm.avgInputTokens > 0.2) {
    assumptions.push(
      `The RAG / agent design puts the final prompt at ~${finalInput.toLocaleString()} tokens, but the Inference assessment was sized for ${ctx.llm.avgInputTokens.toLocaleString()}. Re-run Inference with the design figure so GPU sizing and cost match.`,
    );
  }
  if (agent) assumptions.push(`${agent.label}: ${steps} LLM call(s) per task (${cat.estimation.agentStepsShareOfMax >= 1 ? 'worst case, at its bounded maximum' : `${Math.round(cat.estimation.agentStepsShareOfMax * 100)}% of its maximum ${agent.maxSteps}`}), each intermediate step emitting ~${cat.estimation.toolCallOutputTokens} tokens to call a tool.`);
  if (rerank) assumptions.push(`${rerank.label} scores ${rerank.candidates} candidates per query, each ~${(q + d!.chunkTokens).toLocaleString()} tokens (query + chunk).`);
  if (rag) assumptions.push(`User queries average ${q} tokens and are embedded once per request.`);

  if (!llmOn) assumptions.push('No LLM (vector-only): requests search and embed only - no LLM tokens are projected.');
  else if (share < 1) assumptions.push(`${Math.round(share * 100)}% of requests call the LLM (${llmRequests.toLocaleString()} of ${n.toLocaleString()} a month); search and embedding still run for every request. Per-request figures are per LLM request.`);
  if (llmOn && !agent && nCalls > 1) assumptions.push(`${nCalls} LLM calls per request, each sending the full prompt.`);
  if (retry > 1) assumptions.push(`Retries add ${k.retryRatePercent}% to LLM input and output tokens.`);
  if (cacheShare > 0) assumptions.push(`${k.cacheHitRatePercent}% of input tokens are served from the provider cache - cheaper where a cached-input price is set, but still counted as input tokens.`);
  const llmPerRequestUsd = llmMonthlyUsd !== null && llmRequests > 0 ? llmMonthlyUsd / llmRequests : null;
  const scopeLabel = [rag && 'RAG', agent && 'agent'].filter(Boolean).join(' + ') || (ctx.llm ? 'single LLM call' : 'not yet known');

  return {
    rulesVersion: cat.rulesVersion,
    mode: 'estimated',
    scope: { rag, agent: !!agent, summary: `${scopeLabel} (${ctx.scope.source})` },
    perRequest: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      contextTokens: retrieved,
      embeddingTokens: queryEmbeddingTokens,
      rerankingTokens,
      retrievedChunks: rag ? (rerank ? rerank.candidates : d!.topK) : 0,
      llmCalls: calls.length,
      toolCalls: agent ? steps - 1 : 0,
      input,
    },
    rag: rag
      ? {
          queryTokens: q,
          queryEmbeddingTokens,
          retrievalCount: rerank ? rerank.candidates : d!.topK,
          retrievedContextTokens: retrieved,
          rerankingTokens,
          historyTokens: d!.historyTokens,
          systemPromptTokens: d!.systemPromptTokens,
          finalInputTokens: llmOn ? finalInput : 0,
          outputTokens: llmOn ? answer : 0,
          contextExpansionRatio: q > 0 ? round(retrieved / q, 1) : 0,
        }
      : null,
    agent: agent
      ? {
          pattern: agent.label,
          llmCallsPerTask: steps,
          toolCallsPerTask: steps - 1,
          tokensPerTask: inputTokens + outputTokens,
          steps: calls,
          costPerTaskUsd: llmPerRequestUsd === null ? null : round(llmPerRequestUsd, 6),
          loopGuard: `Bounded to ${agent.maxSteps} steps by the design; in Live mode more LLM calls than that in one trace is flagged as a possible loop.`,
        }
      : null,
    monthly,
    cost: { currency: 'USD', lines, monthlyUsd, perRequestUsd, note },
    budget: { monthlyBudgetUsd: ctx.budget?.monthlyUsd ?? null, shareOfBudget, source: ctx.budget?.source ?? null },
    daily: { requests: Math.round(n / k.operatingDaysPerMonth), totalTokens: Math.round(monthly.totalTokens / k.operatingDaysPerMonth), operatingDaysPerMonth: k.operatingDaysPerMonth },
    llm: { usage: k.llmUsage, requestSharePercent: Math.round(share * 100), llmRequestsPerMonth: llmRequests, retryRatePercent: k.retryRatePercent, cacheHitRatePercent: k.cacheHitRatePercent },
    assumptions,
    gaps,
    wouldChangeIf: [
      'A different primary model or price tier (Model Selection, Inference) - recalculates cost per token.',
      'Top-K, chunk size or reranking (Discovery, Data Pipeline, RAG / agent design) - recalculates retrieved context tokens.',
      'Agent pattern or step limit (RAG / agent design) - recalculates LLM calls and tokens per task.',
      'Traffic (Discovery QPS, Inference requests / day) - recalculates monthly volume.',
      'A price change - recalculates cost from the version in force; past usage keeps its price.',
    ],
  };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
