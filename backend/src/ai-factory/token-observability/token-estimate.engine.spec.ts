import { estimateTokens } from './token-estimate.engine';
import { EstimateContext } from './token-observability.types';
import { MANAGED_API_TIER, PriceRow } from './pricing';

const at = new Date('2026-09-25T00:00:00Z');
let n = 0;
const price = (o: Partial<PriceRow>): PriceRow => ({
  id: `p${++n}`,
  projectId: null,
  provider: MANAGED_API_TIER,
  model: 'mid',
  tokenType: 'input',
  pricePer1M: 3,
  currency: 'USD',
  effectiveFrom: new Date('2026-06-01'),
  effectiveTo: null,
  source: 'test',
  ...o,
});
const PRICES = [price({ tokenType: 'input', pricePer1M: 3 }), price({ tokenType: 'output', pricePer1M: 15 }), price({ provider: 'openai', model: 'emb-small', tokenType: 'embedding', pricePer1M: 0.02 })];
const CAT = { rulesVersion: 'token-observability-test', estimation: { toolCallOutputTokens: 150, agentStepsShareOfMax: 1 }, pricing: { cachedInputPriceFactor: 1, reasoningBilledAs: 'output' as const } };

const ctx = (o: Partial<EstimateContext> = {}): EstimateContext => ({
  scope: { rag: true, agent: true, source: 'RAG / agent design v2' },
  requestsPerMonth: 1_000_000,
  requestsSource: 'Inference assessment v3',
  queryTokens: 30,
  llm: { avgInputTokens: 8_000, avgOutputTokens: 400, provider: MANAGED_API_TIER, model: 'mid', label: 'Mid-size tier', selfHosted: null, assessedPrices: { inputPer1M: 3, outputPer1M: 15 }, source: 'Inference assessment v3' },
  design: {
    systemPromptTokens: 800,
    historyTokens: 2000,
    topK: 5,
    chunkTokens: 512,
    chunkAssumed: false,
    rerank: { id: 'cross_encoder', label: 'Cross-encoder', candidates: 20 },
    agent: { id: 'single_agent', label: 'Single agent', maxSteps: 5, toolSchemaTokens: 1500, toolResultPerStep: 500 },
    source: 'RAG / agent design v2',
  },
  embedding: { provider: 'openai', model: 'emb-small', monthlyNewDocumentTokens: 1_000_000, source: 'Data Pipeline Design v1' },
  budget: { monthlyUsd: 200_000, source: 'Discovery v4' },
  gaps: [],
  ...o,
});
const run = (c: EstimateContext, prices = PRICES, cat = CAT) => estimateTokens(c, prices, cat, at, 'proj');

describe('estimateTokens - RAG + agent (spec §8, §9)', () => {
  const r = run(ctx());

  it('breaks the final prompt into its parts, each labelled with its evidence', () => {
    expect(r.perRequest.input.map((l) => [l.label, l.tokens, l.evidenceType])).toEqual([
      ['System prompt and instructions', 800, 'assumption'],
      ['User query', 30, 'assumption'],
      ['Retrieved context: top 5 × ~512 tokens', 2560, 'estimated'],
      ['Conversation history', 2000, 'assumption'],
      ['Tool schemas', 1500, 'assumption'],
      ['Tool results from 4 earlier step(s)', 2000, 'assumption'],
    ]);
    expect(r.rag).toEqual(
      expect.objectContaining({ queryTokens: 30, queryEmbeddingTokens: 30, retrievalCount: 20, retrievedContextTokens: 2560, rerankingTokens: 20 * 542, finalInputTokens: 8890, outputTokens: 400, contextExpansionRatio: 85.3 }),
    );
  });

  it('counts every agent step: each re-sends the prompt plus the tool results so far', () => {
    expect(r.agent!.steps.map((s) => [s.inputTokens, s.outputTokens])).toEqual([
      [6890, 150],
      [7390, 150],
      [7890, 150],
      [8390, 150],
      [8890, 400],
    ]);
    expect(r.agent).toEqual(expect.objectContaining({ llmCallsPerTask: 5, toolCallsPerTask: 4, tokensPerTask: 39_450 + 1_000 }));
    expect(r.perRequest).toEqual(expect.objectContaining({ inputTokens: 39_450, outputTokens: 1_000, totalTokens: 40_450, llmCalls: 5, toolCalls: 4, contextTokens: 2560, retrievedChunks: 20 }));
  });

  it('projects monthly volume from the request rate, including new-document embedding', () => {
    expect(r.monthly).toEqual(expect.objectContaining({ requests: 1_000_000, inputTokens: 39_450_000_000, outputTokens: 1_000_000_000, totalTokens: 40_450_000_000, embeddingTokens: 31_000_000, rerankingTokens: 10_840_000_000 }));
  });

  it('prices from the table and says what could not be priced instead of guessing', () => {
    expect(r.cost.lines.map((l) => [l.item, l.usd])).toEqual([
      ['LLM input tokens (Mid-size tier)', 118_350],
      ['LLM output tokens (Mid-size tier)', 15_000],
      ['Embedding tokens (emb-small)', 0.62],
      ['Reranking tokens (Cross-encoder)', null],
    ]);
    expect(r.cost.monthlyUsd).toBe(133_350.62);
    expect(r.cost.perRequestUsd).toBeCloseTo(0.13335062, 6);
    expect(r.cost.note).toMatch(/Not priced.*Reranking tokens \(Cross-encoder\).*excludes them/);
    expect(r.agent!.costPerTaskUsd).toBeCloseTo(0.13335, 5);
    expect(r.budget).toEqual({ monthlyBudgetUsd: 200_000, shareOfBudget: 0.6668, source: 'Discovery v4' });
  });

  it('flags when the design prompt is far from what Inference was sized for', () => {
    expect(r.assumptions.join(' ')).not.toMatch(/sized for/); // 8,890 vs 8,000 is within 20%
    expect(run(ctx({ llm: { ...ctx().llm!, avgInputTokens: 2_000 } })).assumptions.join(' ')).toMatch(/~8,890 tokens, but the Inference assessment was sized for 2,000/);
  });
});

describe('estimateTokens - other shapes', () => {
  it('RAG without an agent is one LLM call', () => {
    const r = run(ctx({ scope: { rag: true, agent: false, source: 'x' }, design: { ...ctx().design!, agent: null, rerank: null } }));
    expect(r.agent).toBeNull();
    expect(r.perRequest).toEqual(expect.objectContaining({ llmCalls: 1, toolCalls: 0, inputTokens: 800 + 30 + 2560 + 2000, outputTokens: 400, retrievedChunks: 5, rerankingTokens: 0 }));
  });

  it('without a RAG / agent design takes the prompt whole from Inference and says so', () => {
    const r = run(ctx({ scope: { rag: false, agent: false, source: 'Inference workload type' }, design: null }));
    expect(r.rag).toBeNull();
    expect(r.perRequest.input).toEqual([expect.objectContaining({ tokens: 8_000, evidenceType: 'estimated' })]);
    expect(r.perRequest.totalTokens).toBe(8_400);
    expect(r.assumptions[0]).toMatch(/No RAG \/ agent design yet/);
  });

  it('estimates a typical agent run as a share of its maximum steps when configured', () => {
    const r = run(ctx(), PRICES, { ...CAT, estimation: { ...CAT.estimation, agentStepsShareOfMax: 0.6 } });
    expect(r.agent!.llmCallsPerTask).toBe(3);
    expect(r.assumptions.join(' ')).toMatch(/60% of its maximum 5/);
  });

  it('shows self-hosted serving as capacity cost, never as a token price', () => {
    const r = run(ctx({ llm: { ...ctx().llm!, selfHosted: { monthlyUsd: 40_000, label: '4 × H100' } } }));
    expect(r.cost.lines[0]).toEqual(expect.objectContaining({ item: 'LLM serving (self-hosted, 4 × H100)', usd: 40_000, evidenceType: 'estimated' }));
    expect(r.cost.lines[0].price).toMatch(/not a token price/);
  });

  it('prices at the version in force at that moment (spec §13)', () => {
    const history = [price({ tokenType: 'input', pricePer1M: 3, effectiveTo: new Date('2026-09-01') }), price({ tokenType: 'input', pricePer1M: 1, effectiveFrom: new Date('2026-09-01') }), price({ tokenType: 'output', pricePer1M: 15 })];
    const before = estimateTokens(ctx(), history, CAT, new Date('2026-08-15'), 'proj');
    const after = estimateTokens(ctx(), history, CAT, at, 'proj');
    expect(before.cost.lines[0].usd).toBe(118_350);
    expect(after.cost.lines[0].usd).toBe(39_450);
  });

  it('notes when Inference ran with prices the table does not have', () => {
    const r = run(ctx({ llm: { ...ctx().llm!, assessedPrices: { inputPer1M: 2, outputPer1M: 10 } } }));
    expect(r.assumptions.join(' ')).toMatch(/used \$2 \/ \$10.*price table has \$3 \/ \$15/);
  });

  it('with nothing upstream yet estimates nothing rather than inventing figures', () => {
    const r = run(ctx({ scope: { rag: false, agent: false, source: 'unknown' }, llm: null, design: null, embedding: null, requestsPerMonth: 0, requestsSource: null, budget: null, gaps: ['No Inference assessment yet.'] }));
    expect(r.perRequest.totalTokens).toBe(0);
    expect(r.perRequest.llmCalls).toBe(0);
    expect(r.cost.monthlyUsd).toBeNull();
    expect(r.monthly.basis).toMatch(/No request volume yet/);
    expect(r.gaps).toEqual(['No Inference assessment yet.']);
  });
});
