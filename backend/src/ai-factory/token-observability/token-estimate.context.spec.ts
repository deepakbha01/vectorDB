import { resolveEstimateContext, EstimateCatalogues, EstimateInputs } from './token-estimate.context';
import { ChunkingStrategy } from '../../chunking/enums/chunking-strategy.enum';
import { MANAGED_API_TIER } from './pricing';

const CAT: EstimateCatalogues = {
  ragAgent: {
    assumptions: { tokens: { systemPrompt: 800, conversationHistory: 2000, toolSchemas: 1500, toolResultPerStep: 500, defaultOutputReserve: 1000 } },
    reranking: { candidateMultiplier: 4, maxCandidates: 100 },
    agent: { options: [{ id: 'single_agent', maxSteps: 5 }] },
  } as any,
  avgQueryTokens: 30,
  charsPerToken: 4,
};

const inference = (o: Record<string, any> = {}) =>
  ({
    version: 3,
    inputsUsed: { workloadType: 'rag', managedApiTier: { id: 'mid', label: 'Mid tier', inputPer1M: 3, outputPer1M: 15 }, avgInputTokens: 3000, avgOutputTokens: 400, monthlyBudgetUsd: 5000 },
    result: { demand: { requestsPerMonth: 912_000 }, decision: 'managed_api', recommendedGpuOption: { monthlyTotalUsd: 30_000, totalGpusAtPeak: 4, gpuLabel: 'H100' } },
    ...o,
  }) as any;
const design = (o: Record<string, any> = {}) =>
  ({
    version: 2,
    context: { rag: true, agent: true, topK: 30, chunkTokens: 400, multiTurn: false, ...o },
    result: { decisions: [{ area: 'reranking', chosen: { id: 'cross_encoder', label: 'Cross-encoder' } }, { area: 'agent', chosen: { id: 'single_agent', label: 'Single agent' } }] },
  }) as any;
const none: EstimateInputs = { discovery: null, pipeline: null, modelSelection: null, inference: null, design: null, profile: null };

describe('resolveEstimateContext', () => {
  it('takes scope, context make-up, reranking and agent steps from the RAG / agent design', () => {
    const { context, sources } = resolveEstimateContext({ ...none, inference: inference(), design: design() }, CAT);
    expect(context.scope).toEqual({ rag: true, agent: true, source: 'RAG / agent design v2' });
    expect(context.design).toEqual(
      expect.objectContaining({ systemPromptTokens: 800, historyTokens: 0, topK: 30, chunkTokens: 400, chunkAssumed: false, rerank: { id: 'cross_encoder', label: 'Cross-encoder', candidates: 100 }, agent: expect.objectContaining({ maxSteps: 5 }) }),
    );
    expect(sources.design.detail).toMatch(/top-K 30/);
  });

  it('counts conversation history only for multi-turn designs and flags an assumed chunk size', () => {
    const { context } = resolveEstimateContext({ ...none, design: design({ multiTurn: true, chunkTokens: null }) }, CAT);
    expect(context.design).toEqual(expect.objectContaining({ historyTokens: 2000, chunkTokens: 512, chunkAssumed: true }));
  });

  it('falls back to the Workload Profile, then the Inference workload type, for scope', () => {
    const profile = { version: 1, result: { architecture: { class: 'hybrid', components: ['rag', 'agent'] } } } as any;
    expect(resolveEstimateContext({ ...none, profile }, CAT).context.scope).toEqual({ rag: true, agent: true, source: 'Workload Profile v1 (no RAG / agent design yet)' });
    expect(resolveEstimateContext({ ...none, inference: inference() }, CAT).context.scope).toEqual({ rag: true, agent: false, source: 'Inference assessment v3 workload type' });
    expect(resolveEstimateContext({ ...none, profile }, CAT).context.gaps[0]).toMatch(/No RAG \/ agent design yet/);
  });

  it('prices the model at the tier Inference sized, and treats self-hosted serving as capacity cost like FinOps', () => {
    const managed = resolveEstimateContext({ ...none, inference: inference() }, CAT).context.llm!;
    expect(managed).toEqual(expect.objectContaining({ provider: MANAGED_API_TIER, model: 'mid', selfHosted: null, assessedPrices: { inputPer1M: 3, outputPer1M: 15 } }));
    const self = resolveEstimateContext({ ...none, inference: inference({ result: { ...inference().result, decision: 'self_hosted' } }) }, CAT).context.llm!;
    expect(self.selfHosted).toEqual({ monthlyUsd: 30_000, label: '4 × H100' });
  });

  it('uses Inference request volume, else Discovery QPS', () => {
    expect(resolveEstimateContext({ ...none, inference: inference() }, CAT).context.requestsPerMonth).toBe(912_000);
    const r = resolveEstimateContext({ ...none, discovery: { version: 4, qps: 2 } as any }, CAT).context;
    expect(r.requestsPerMonth).toBe(Math.round(2 * 86_400 * 30.4));
    expect(r.requestsSource).toBe('Discovery v4: 2 QPS average');
  });

  it('computes new-document embedding tokens the same way FinOps does', () => {
    const pipeline = { version: 1, chunkingStrategy: ChunkingStrategy.TOKEN_BASED, chunkSize: 500, embeddingProviderId: 'openai', embeddingModelId: 'emb-small' } as any;
    const discovery = { version: 2, documentCount: 10_000, chunksPerDocument: 8, documentGrowthPercentPerMonth: 5, qps: 1, monthlyBudgetUsd: 9000 } as any;
    const { context } = resolveEstimateContext({ ...none, pipeline, discovery }, CAT);
    expect(context.embedding).toEqual(expect.objectContaining({ provider: 'openai', model: 'emb-small', monthlyNewDocumentTokens: 2_000_000 })); // 10,000 docs × 8 chunks × 500 tokens × 5%
    expect(context.budget).toEqual({ monthlyUsd: 9000, source: 'Discovery v2' });
  });

  it('reports what is missing instead of assuming it', () => {
    const { context } = resolveEstimateContext(none, CAT);
    expect(context.llm).toBeNull();
    expect(context.requestsPerMonth).toBe(0);
    expect(context.gaps).toEqual(['No Inference assessment yet - request volume, token sizes and serving are unknown.']);
  });
});
