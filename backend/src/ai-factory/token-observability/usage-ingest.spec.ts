import { isRejection, normalizeEvent, NormalizedEvent, rollupDeltas } from './usage-ingest';
import { MANAGED_API_TIER, PriceRow } from './pricing';
import { UsageEventDto } from './dto/usage-events.dto';

const now = new Date('2026-09-25T12:00:00Z');
const T = { cachedInputPriceFactor: 1, reasoningBilledAs: 'output' as const };
let n = 0;
const price = (o: Partial<PriceRow>): PriceRow => ({ id: `p${++n}`, projectId: null, provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 3, currency: 'USD', effectiveFrom: new Date('2026-06-01'), effectiveTo: null, source: 't', ...o });
const PRICES = [
  price({ tokenType: 'input', pricePer1M: 3, effectiveTo: new Date('2026-09-20') }),
  price({ tokenType: 'input', pricePer1M: 1, effectiveFrom: new Date('2026-09-20') }),
  price({ tokenType: 'output', pricePer1M: 15 }),
  price({ provider: 'openai', model: 'emb', tokenType: 'embedding', pricePer1M: 0.02 }),
];
const ev = (o: Partial<UsageEventDto> = {}): UsageEventDto => ({ eventId: `e${++n}`, timestamp: '2026-09-25T10:15:00Z', provider: MANAGED_API_TIER, model: 'mid', operationType: 'chat', inputTokens: 1000, outputTokens: 200, ...o }) as UsageEventDto;
const norm = (e: UsageEventDto) => {
  const r = normalizeEvent(e, 'live', PRICES, 'proj', T, now);
  if (isRejection(r)) throw new Error(r.reason);
  return r;
};

describe('normalizeEvent', () => {
  it('fills the defaults a chat span implies and prices it at the price in force at its timestamp', () => {
    const r = norm(ev());
    expect(r).toEqual(expect.objectContaining({ totalTokens: 1200, llmCallCount: 1, toolCallCount: 0, requestStatus: 'success', currency: 'USD', telemetrySource: 'live' }));
    expect(r.estimatedInputCost).toBeCloseTo(0.001); // 1,000 × $1 / 1M (the price from 2026-09-20)
    expect(r.estimatedOutputCost).toBeCloseTo(0.003);
    // The same call a week earlier keeps the older price - history is never repriced.
    expect(norm(ev({ timestamp: '2026-09-18T10:00:00Z' })).estimatedInputCost).toBeCloseTo(0.003);
    expect(r.priceRefs.map((p) => p.pricePer1M)).toEqual([1, 15]);
  });

  it('moves embedding and rerank tokens out of LLM input', () => {
    const e = norm(ev({ provider: 'openai', model: 'emb', operationType: 'embeddings', inputTokens: 30, outputTokens: 0 }));
    expect(e).toEqual(expect.objectContaining({ inputTokens: 0, embeddingTokens: 30, totalTokens: 0, llmCallCount: 0 }));
    expect(e.estimatedTotalCost).toBeCloseTo(30 * 0.02 / 1e6);
    const r = norm(ev({ operationType: 'rerank', inputTokens: 5000, outputTokens: 0 }));
    expect(r).toEqual(expect.objectContaining({ inputTokens: 0, rerankingTokens: 5000 }));
  });

  it('leaves the cost empty when no price is in force, rather than guessing', () => {
    const r = norm(ev({ provider: 'acme', model: 'x' }));
    expect(r.estimatedTotalCost).toBeNull();
    expect(r.currency).toBeNull();
  });

  it('counts a tool span as a tool call and marks an error from its error type', () => {
    expect(norm(ev({ operationType: 'execute_tool', toolName: 'search', inputTokens: 0, outputTokens: 0, errorType: 'timeout' }))).toEqual(
      expect.objectContaining({ toolCallCount: 1, llmCallCount: 0, requestStatus: 'error', errorType: 'timeout' }),
    );
  });

  it.each([
    [{ timestamp: '2026-09-25T13:00:00Z' }, /future/],
    [{ inputTokens: 10, cachedInputTokens: 20 }, /cachedInputTokens exceed/],
    [{ outputTokens: 10, reasoningTokens: 20 }, /reasoningTokens exceed/],
  ])('rejects %p', (o, reason) => {
    const r = normalizeEvent(ev(o as Partial<UsageEventDto>), 'live', PRICES, 'proj', T, now);
    expect(isRejection(r) && r.reason).toMatch(reason);
  });
});

describe('rollupDeltas', () => {
  it('adds events up per hour and attribution key, with missing dimensions as empty strings', () => {
    const a = norm(ev({ serviceId: 'claims', timestamp: '2026-09-25T10:05:00Z' }));
    const b = norm(ev({ serviceId: 'claims', timestamp: '2026-09-25T10:55:00Z', requestStatus: 'error', latencyMs: 300 }));
    const c = norm(ev({ serviceId: 'claims', timestamp: '2026-09-25T11:01:00Z' }));
    const d = norm(ev({ serviceId: 'billing', timestamp: '2026-09-25T10:30:00Z' }));
    const deltas = rollupDeltas([a, b, c, d] as NormalizedEvent[]);
    expect(deltas).toHaveLength(3);
    const claims10 = deltas.find((x) => x.serviceId === 'claims' && x.bucketStart.toISOString() === '2026-09-25T10:00:00.000Z')!;
    expect(claims10).toEqual(expect.objectContaining({ events: 2, errors: 1, inputTokens: 2000, totalTokens: 2400, llmCalls: 2, latencyMsSum: 300, applicationId: '', environment: '' }));
    expect(claims10.costTotal).toBeCloseTo(0.008);
  });
});

describe('rollupDeltas - write order (review fix)', () => {
  it('returns the same order whatever order the events arrived in, so concurrent batches cannot deadlock', () => {
    const a = norm(ev({ serviceId: 'b-svc', timestamp: '2026-09-25T11:10:00Z' }));
    const b = norm(ev({ serviceId: 'a-svc', timestamp: '2026-09-25T10:10:00Z' }));
    const c = norm(ev({ serviceId: 'a-svc', timestamp: '2026-09-25T11:20:00Z' }));
    const keys = (xs: NormalizedEvent[]) => rollupDeltas(xs).map((d) => `${d.bucketStart.toISOString()} ${d.serviceId}`);
    expect(keys([a, b, c])).toEqual(keys([c, b, a]));
    expect(keys([a, b, c])).toEqual(['2026-09-25T10:00:00.000Z a-svc', '2026-09-25T11:00:00.000Z a-svc', '2026-09-25T11:00:00.000Z b-svc']);
  });
});
