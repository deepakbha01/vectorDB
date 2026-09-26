import { applyInputs, InputSources, PatternRef } from './estimate-inputs';
import { estimateTokens } from './token-estimate.engine';
import { EstimateContext } from './token-observability.types';
import { MANAGED_API_TIER, PriceRow } from './pricing';

const base = (o: Partial<EstimateContext> = {}): EstimateContext => ({
  scope: { rag: true, agent: false, source: 'RAG / agent design v1' },
  requestsPerMonth: 0,
  requestsSource: null,
  queryTokens: 30,
  llm: { avgInputTokens: 4_000, avgOutputTokens: 300, provider: MANAGED_API_TIER, model: 'mid', label: 'Mid', selfHosted: null, assessedPrices: { inputPer1M: 3, outputPer1M: 15 }, source: 'Inference assessment v2' },
  design: { systemPromptTokens: 800, historyTokens: 0, topK: 5, chunkTokens: 500, chunkAssumed: false, rerank: null, agent: null, source: 'RAG / agent design v1' },
  embedding: null,
  budget: null,
  gaps: [],
  ...o,
});
const ragPattern: PatternRef = { id: 'enterprise-document-rag', name: 'Enterprise Document RAG', qps: 15, profile: { workloadType: 'rag', llmUsage: 'required', llmRequestSharePercent: 100, llmCallsPerRequest: 1, agentStepsPerRequest: null, guidance: [] } };
const searchPattern: PatternRef = { id: 'high-qps-enterprise-search', name: 'High-QPS Enterprise Search', qps: 300, profile: { workloadType: 'search', llmUsage: 'optional', llmRequestSharePercent: null, llmCallsPerRequest: null, agentStepsPerRequest: null, guidance: [] } };
const recPattern: PatternRef = { id: 'recommendation-engine', name: 'Recommendation Engine', qps: 200, profile: { workloadType: 'recommendation', llmUsage: 'none', llmRequestSharePercent: 0, llmCallsPerRequest: 0, agentStepsPerRequest: null, guidance: [] } };
const src = (o: Partial<InputSources> = {}): InputSources => ({ pattern: ragPattern, discovery: null, inference: null, operatingDaysPerMonth: 30.4, ...o });
const input = (r: ReturnType<typeof applyInputs>, key: string) => r.inputs.find((i) => i.key === key)!;

const PRICES: PriceRow[] = [
  { id: 'a', projectId: null, provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 3, currency: 'USD', effectiveFrom: new Date('2026-01-01'), effectiveTo: null, source: 't' },
  { id: 'b', projectId: null, provider: MANAGED_API_TIER, model: 'mid', tokenType: 'output', pricePer1M: 15, currency: 'USD', effectiveFrom: new Date('2026-01-01'), effectiveTo: null, source: 't' },
];
const CAT = { rulesVersion: 't', estimation: { toolCallOutputTokens: 150, agentStepsShareOfMax: 1 }, pricing: { cachedInputPriceFactor: 0.1, reasoningBilledAs: 'output' as const } };
const run = (c: EstimateContext) => estimateTokens(c, PRICES, CAT, new Date('2026-09-25'), 'p');

describe('applyInputs - provenance (validation spec §1, §17)', () => {
  it('labels each value by where it came from', () => {
    const r = applyInputs(base(), { retryRatePercent: 5 }, src({ discovery: { version: 3, qps: 12 } }));
    expect(input(r, 'retryRatePercent')).toEqual(expect.objectContaining({ value: 5, provenance: 'user_override' }));
    expect(input(r, 'qps')).toEqual(expect.objectContaining({ value: 12, provenance: 'calculated', source: 'Discovery v3' }));
    expect(input(r, 'llmUsage')).toEqual(expect.objectContaining({ value: 'required', provenance: 'pattern_default', source: 'Pattern: Enterprise Document RAG' }));
    expect(input(r, 'systemPromptTokens')).toEqual(expect.objectContaining({ value: 800, provenance: 'calculated' }));
    expect(input(r, 'cacheHitRatePercent')).toEqual(expect.objectContaining({ value: null, provenance: 'not_configured', source: 'Not configured' }));
  });

  it('never assumes 100% utilization: QPS alone gives no volume', () => {
    const r = applyInputs(base(), {}, src({ discovery: { version: 1, qps: 10 } }));
    expect(input(r, 'utilizationPercent').provenance).toBe('not_configured');
    expect(input(r, 'requestsPerDay').provenance).toBe('not_configured');
    expect(r.context.requestsPerMonth).toBe(0);
    expect(r.context.gaps.join(' ')).toMatch(/utilization is never assumed/);
  });

  it('turns QPS × utilization into requests per day, and days into a month', () => {
    const r = applyInputs(base(), { utilizationPercent: 25, operatingDaysPerMonth: 20 }, src({ discovery: { version: 1, qps: 10 } }));
    expect(input(r, 'requestsPerDay').value).toBe(216_000);
    expect(r.context.requestsPerMonth).toBe(4_320_000);
  });

  it('keeps the Inference month exact unless the user changes the volume or days', () => {
    const inference = { version: 2, requestsPerMonth: 1_000_000, avgInputTokens: 4_000, avgOutputTokens: 300 };
    expect(applyInputs(base(), {}, src({ inference })).context.requestsPerMonth).toBe(1_000_000);
    // A QPS the user set beats the Inference volume.
    expect(applyInputs(base(), { qps: 1, utilizationPercent: 50 }, src({ inference })).context.requestsPerMonth).toBe(Math.round(43_200 * 30.4));
  });

  it('keeps a user override when the pattern says otherwise', () => {
    const r = applyInputs(base(), { llmUsage: 'none' }, src({ pattern: ragPattern }));
    expect(input(r, 'llmUsage')).toEqual(expect.objectContaining({ value: 'none', provenance: 'user_override' }));
    expect(r.context.knobs!.llmUsage).toBe('none');
  });

  it('never invents an LLM share for an optional-LLM search pattern', () => {
    const r = applyInputs(base({ scope: { rag: false, agent: false, source: 'not yet known' }, design: null }), {}, src({ pattern: searchPattern }));
    expect(input(r, 'llmRequestSharePercent').provenance).toBe('not_configured');
    expect(r.context.knobs!.llmRequestSharePercent).toBe(0);
    expect(r.context.gaps.join(' ')).toMatch(/search QPS is not LLM QPS/);
  });

  it('treats a vector-only pattern as no LLM', () => {
    const r = applyInputs(base(), { requestsPerDay: 1000 }, src({ pattern: recPattern }));
    expect(input(r, 'llmRequestSharePercent')).toEqual(expect.objectContaining({ value: 0, provenance: 'calculated' }));
    const e = run(r.context);
    expect(e.perRequest.llmCalls).toBe(0);
    expect(e.monthly.inputTokens).toBe(0);
    expect(e.assumptions.join(' ')).toMatch(/vector-only/);
  });

  it('takes the scope from the pattern only when no phase has said anything', () => {
    const r = applyInputs(base({ scope: { rag: false, agent: false, source: 'not yet known' } }), {}, src({ pattern: ragPattern }));
    expect(r.context.scope).toEqual({ rag: true, agent: false, source: 'Pattern: Enterprise Document RAG' });
  });
});

describe('estimate knobs (validation spec §3)', () => {
  const ctx = (o = {}) => applyInputs(base(), { requestsPerDay: 10_000, ...o }, src()).context;

  it('reports tokens per day', () => {
    const e = run(ctx({ operatingDaysPerMonth: 20 }));
    expect(e.daily).toEqual(expect.objectContaining({ requests: 10_000, operatingDaysPerMonth: 20 }));
    expect(e.daily!.totalTokens).toBe(Math.round(e.monthly.totalTokens / 20));
  });

  it('scales LLM tokens by the share of requests that call the LLM', () => {
    const all = run(ctx());
    const half = run(ctx({ llmRequestSharePercent: 50 }));
    expect(half.monthly.inputTokens).toBe(Math.round(all.monthly.inputTokens / 2));
    expect(half.llm).toEqual(expect.objectContaining({ requestSharePercent: 50 }));
  });

  it('adds retries to both sides and applies the cache only to cost', () => {
    const plain = run(ctx());
    const retried = run(ctx({ retryRatePercent: 10 }));
    expect(retried.perRequest.inputTokens).toBe(Math.round(plain.perRequest.inputTokens * 1.1));
    const cached = run(ctx({ cacheHitRatePercent: 50 }));
    expect(cached.monthly.inputTokens).toBe(plain.monthly.inputTokens);
    expect(cached.cost.monthlyUsd!).toBeLessThan(plain.cost.monthlyUsd!);
  });

  it('uses an overridden retrieved-context size in place of top-K × chunk', () => {
    const e = run(ctx({ retrievedContextTokens: 1_000 }));
    expect(e.perRequest.contextTokens).toBe(1_000);
  });
});
