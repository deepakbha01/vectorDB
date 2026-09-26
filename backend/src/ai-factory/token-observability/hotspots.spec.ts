import { buildHotspots, findSpike, HotspotInputs, ServiceUsage } from './hotspots';

const H = 3_600_000;
const t0 = new Date('2026-09-01T00:00:00Z').getTime();
const hour = (i: number) => new Date(t0 + i * H);
const RULE = { baselineDays: 7, factor: 3, minTokens: 1_000 };

const svc = (o: Partial<ServiceUsage>): ServiceUsage => ({ applicationId: 'claims', serviceId: 'intake', requests: 20, totalTokens: 20_000, llmCalls: 20, cost: 2, unpricedEvents: 0, contextTokens: 0, queryTokens: 0, ...o });

const inputs = (o: Partial<HotspotInputs> = {}): HotspotInputs => ({
  applications: [{ applicationId: 'claims', totalTokens: 90_000 }, { applicationId: 'billing', totalTokens: 10_000 }],
  services: [{ applicationId: 'claims', serviceId: 'intake', totalTokens: 60_000 }, { applicationId: 'billing', serviceId: 'invoices', totalTokens: 10_000 }],
  models: [{ provider: 'openai', model: 'gpt-x', totalTokens: 80_000 }],
  perService: [
    svc({}),
    svc({ serviceId: 'triage', requests: 10, totalTokens: 30_000, llmCalls: 40, cost: 6, contextTokens: 8_000, queryTokens: 100 }),
    // Heavier per request, but too few requests to rank.
    svc({ serviceId: 'rare', requests: 2, totalTokens: 50_000, llmCalls: 30, cost: 50 }),
    // Most expensive per request, but part of its usage has no price - its cost is incomplete.
    svc({ serviceId: 'unpriced', requests: 50, totalTokens: 5_000, cost: 100, unpricedEvents: 3 }),
  ],
  growth: [
    { applicationId: 'claims', serviceId: 'intake', current: 60_000, baseline: 40_000 },
    { applicationId: 'claims', serviceId: 'triage', current: 30_000, baseline: 10_000 },
    // No comparable previous period: never "infinite growth".
    { applicationId: 'billing', serviceId: 'new', current: 5_000, baseline: 0 },
  ],
  hourly: [],
  range: { from: hour(0), to: hour(24) },
  minRequests: 10,
  spikeRule: RULE,
  ...o,
});
const byKey = (o?: Partial<HotspotInputs>) => Object.fromEntries(buildHotspots(inputs(o)).map((h) => [h.key, h]));

describe('buildHotspots (validation spec §7)', () => {
  const h = byKey();

  it('lists all nine hotspots in the spec order', () => {
    expect(buildHotspots(inputs()).map((x) => x.key)).toEqual(['topApplication', 'topService', 'topModel', 'tokensPerRequest', 'fastestGrowth', 'ragContextExpansion', 'llmCallsPerRequest', 'costPerRequest', 'tokenSpike']);
  });

  it('names the biggest consumers, each with the filter a click applies', () => {
    expect(h.topApplication).toEqual(expect.objectContaining({ subject: 'claims', value: 90_000, drill: { dims: { application: 'claims' } } }));
    expect(h.topService).toEqual(expect.objectContaining({ subject: 'claims / intake', value: 60_000, drill: { dims: { application: 'claims', service: 'intake' } } }));
    expect(h.topModel).toEqual(expect.objectContaining({ subject: 'openai / gpt-x', drill: { dims: { provider: 'openai', model: 'gpt-x' } } }));
  });

  it('ranks per-request figures only where there are enough requests', () => {
    expect(h.tokensPerRequest).toEqual(expect.objectContaining({ subject: 'claims / triage', value: 3_000 }));
    expect(h.llmCallsPerRequest).toEqual(expect.objectContaining({ subject: 'claims / triage', value: 4 }));
  });

  it('ranks cost per request only where every event was priced', () => {
    expect(h.costPerRequest).toEqual(expect.objectContaining({ subject: 'claims / triage', value: 0.6 }));
  });

  it('measures growth against a comparable previous period only', () => {
    expect(h.fastestGrowth).toEqual(expect.objectContaining({ subject: 'claims / triage', value: 200 }));
  });

  it('reports the largest RAG context expansion as context / query tokens', () => {
    expect(h.ragContextExpansion).toEqual(expect.objectContaining({ subject: 'claims / triage', value: 80 }));
  });

  it('says why a hotspot is empty instead of inventing one', () => {
    const empty = byKey({ applications: [], services: [], models: [], perService: [], growth: [] });
    for (const k of ['topApplication', 'topService', 'topModel', 'tokensPerRequest', 'fastestGrowth', 'ragContextExpansion', 'llmCallsPerRequest', 'costPerRequest', 'tokenSpike']) {
      expect(empty[k]).toEqual(expect.objectContaining({ subject: null, value: null, drill: null }));
      expect(empty[k].detail.length).toBeGreaterThan(10);
    }
  });
});

describe('findSpike - the spike alert rule, over a range', () => {
  // Two days of steady 1,000 tokens / hour, then one hour at 5,000.
  const steady = Array.from({ length: 48 }, (_, i) => ({ bucket: hour(i), tokens: 1_000 }));
  const series = [...steady, { bucket: hour(48), tokens: 5_000 }, { bucket: hour(49), tokens: 1_000 }];

  it('finds an hour at least factor × its usual volume', () => {
    const s = findSpike(series, hour(24), hour(50), RULE);
    expect(s).toEqual(expect.objectContaining({ bucket: hour(48), tokens: 5_000, baselineHourly: 1_000, ratio: 5 }));
  });

  it('needs a day of history, the minimum volume, and the hour inside the range', () => {
    expect(findSpike([{ bucket: hour(0), tokens: 1_000 }, { bucket: hour(5), tokens: 9_000 }], hour(0), hour(24), RULE)).toBeNull();
    expect(findSpike(series, hour(24), hour(50), { ...RULE, minTokens: 10_000 })).toBeNull();
    expect(findSpike(series, hour(24), hour(48), RULE)).toBeNull();
  });

  it('counts quiet hours as zero, so a gap does not hide a spike', () => {
    const sparse = [...Array.from({ length: 24 }, (_, i) => ({ bucket: hour(i), tokens: 1_000 })), { bucket: hour(47), tokens: 2_000 }];
    // Baseline over hours 0-46 (47 h): 24,000 / 47 ≈ 511 → 2,000 is ≈ 3.9×.
    expect(findSpike(sparse, hour(24), hour(48), RULE)?.ratio).toBeCloseTo(2_000 / (24_000 / 47));
  });

  it('is surfaced as the ninth hotspot with a one-hour drill-down', () => {
    const h = byKey({ hourly: series, range: { from: hour(24), to: hour(50) } });
    expect(h.tokenSpike).toEqual(expect.objectContaining({ subject: hour(48).toISOString(), value: 5, drill: { from: hour(48).toISOString(), to: hour(49).toISOString() } }));
  });
});
