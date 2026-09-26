import { cataloguePrices, costOf, MANAGED_API_TIER, planPriceSync, PriceRow, PricingTreatment, resolvePrice } from './pricing';

const treatment: PricingTreatment = { currency: 'USD', catalogueEffectiveFrom: '2026-06-01', cachedInputPriceFactor: 1, reasoningBilledAs: 'output', prices: [] };
const d = (s: string) => new Date(s);
let n = 0;
const row = (o: Partial<PriceRow>): PriceRow => ({
  id: `p${++n}`,
  projectId: null,
  provider: MANAGED_API_TIER,
  model: 'mid',
  tokenType: 'input',
  pricePer1M: 3,
  currency: 'USD',
  effectiveFrom: d('2026-06-01'),
  effectiveTo: null,
  source: 'test',
  ...o,
});

describe('cataloguePrices', () => {
  const tiers = [{ id: 'mid', label: 'Mid tier', inputPer1M: 3, outputPer1M: 15 }];
  const providers = [{ id: 'openai', label: 'OpenAI', models: [{ id: 'emb-small', label: 'emb-small', costPerMillionTokens: 0.02 }, { id: 'no-price', label: 'x' }] }];

  it('seeds from the existing catalogues instead of copying their figures', () => {
    const p = cataloguePrices(tiers, providers, treatment);
    expect(p).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 3, currency: 'USD' }),
        expect.objectContaining({ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'output', pricePer1M: 15 }),
        expect.objectContaining({ provider: 'openai', model: 'emb-small', tokenType: 'embedding', pricePer1M: 0.02 }),
      ]),
    );
    expect(p.some((x) => x.model === 'no-price')).toBe(false);
  });

  it('lets an explicit row in token-observability.yaml replace the catalogue figure for the same key', () => {
    const p = cataloguePrices(tiers, providers, { ...treatment, prices: [{ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 2.5, source: 'contract' }] });
    expect(p.filter((x) => x.model === 'mid' && x.tokenType === 'input')).toEqual([expect.objectContaining({ pricePer1M: 2.5, source: 'contract' })]);
  });
});

describe('planPriceSync', () => {
  const now = d('2026-09-25T10:00:00Z');
  const seed = d('2026-06-01');

  it('seeds a new key from the catalogue effective date', () => {
    const plan = planPriceSync([], [{ provider: 'x', model: 'm', tokenType: 'input', pricePer1M: 1, source: 's' }], now, seed);
    expect(plan.close).toEqual([]);
    expect(plan.insert).toEqual([expect.objectContaining({ effectiveFrom: seed.toISOString(), currency: 'USD' })]);
  });

  it('does nothing when the price is unchanged', () => {
    expect(planPriceSync([row({})], [{ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 3, source: 's', currency: 'USD' }], now, seed)).toEqual({ close: [], insert: [] });
  });

  it('closes the open row and opens a new one when a price changes - history is never edited', () => {
    const open = row({});
    const plan = planPriceSync([open], [{ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 2, source: 's', currency: 'USD' }], now, seed);
    expect(plan.close).toEqual([{ id: open.id, effectiveTo: now }]);
    expect(plan.insert).toEqual([expect.objectContaining({ pricePer1M: 2, effectiveFrom: now.toISOString() })]);
  });

  it('ignores project overrides and refuses a change dated before the open row', () => {
    const plan = planPriceSync(
      [row({ projectId: 'proj', pricePer1M: 1 }), row({ effectiveFrom: d('2026-09-01') })],
      [{ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 2, source: 's', currency: 'USD', effectiveFrom: '2026-08-01' }],
      now,
      seed,
    );
    expect(plan).toEqual({ close: [], insert: [] });
  });
});

describe('resolvePrice', () => {
  const old = row({ pricePer1M: 3, effectiveTo: d('2026-09-01') });
  const current = row({ pricePer1M: 2, effectiveFrom: d('2026-09-01') });
  const contract = row({ projectId: 'proj', pricePer1M: 1, effectiveFrom: d('2026-09-10') });
  const rows = [old, current, contract];

  it('returns the price in force at the moment asked, so past usage keeps its price', () => {
    expect(resolvePrice(rows, MANAGED_API_TIER, 'mid', 'input', d('2026-08-15'), null)?.id).toBe(old.id);
    expect(resolvePrice(rows, MANAGED_API_TIER, 'mid', 'input', d('2026-09-05'), null)?.id).toBe(current.id);
  });

  it('prefers the project override while it is in force', () => {
    expect(resolvePrice(rows, MANAGED_API_TIER, 'mid', 'input', d('2026-09-05'), 'proj')?.id).toBe(current.id);
    expect(resolvePrice(rows, MANAGED_API_TIER, 'mid', 'input', d('2026-09-20'), 'proj')?.id).toBe(contract.id);
    expect(resolvePrice(rows, MANAGED_API_TIER, 'mid', 'input', d('2026-09-20'), 'other')?.id).toBe(current.id);
  });

  it('returns null before any price existed', () => {
    expect(resolvePrice(rows, MANAGED_API_TIER, 'mid', 'input', d('2026-01-01'), null)).toBeNull();
  });
});

describe('resolvePrice - regions (validation spec §11)', () => {
  const at = d('2026-09-20');
  const anyRegion = row({ pricePer1M: 3 });
  const euCatalogue = row({ region: 'eu-west-1', pricePer1M: 3.3 });
  const projAny = row({ projectId: 'proj', pricePer1M: 2 });
  const projEu = row({ projectId: 'proj', region: 'eu-west-1', pricePer1M: 2.2 });
  const rows = [anyRegion, euCatalogue, projAny, projEu];
  const pick = (projectId: string | null, region: string | null, from = rows) => resolvePrice(from, MANAGED_API_TIER, 'mid', 'input', at, projectId, region)?.id;

  it('takes the most specific price: project + region, project, catalogue + region, catalogue', () => {
    expect(pick('proj', 'eu-west-1')).toBe(projEu.id);
    expect(pick('proj', 'eu-west-1', [anyRegion, euCatalogue, projAny])).toBe(projAny.id);
    expect(pick('other', 'eu-west-1')).toBe(euCatalogue.id);
    expect(pick('other', 'us-east-1')).toBe(anyRegion.id);
  });

  it('never applies another region, and usage with no region takes region-less prices only', () => {
    expect(pick(null, 'us-east-1', [euCatalogue])).toBeUndefined();
    expect(pick('proj', null)).toBe(projAny.id);
    expect(pick(null, null, [euCatalogue])).toBeUndefined();
  });

  it('prices a call at its regional rate and records the region used', () => {
    const c = costOf(rows, MANAGED_API_TIER, 'mid', { input: 1_000_000, output: 0 }, at, 'other', treatment, 'eu-west-1');
    expect(c.totalCost).toBeCloseTo(3.3);
    expect(c.refs).toEqual([expect.objectContaining({ id: euCatalogue.id, region: 'eu-west-1' })]);
  });

  it('keeps a regional catalogue row apart from the region-less one when syncing', () => {
    const plan = planPriceSync([anyRegion], [{ provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', region: 'eu-west-1', pricePer1M: 3.3, source: 'eu list' }], d('2026-09-25'), d('2026-06-01'));
    expect(plan.close).toEqual([]);
    expect(plan.insert).toEqual([expect.objectContaining({ region: 'eu-west-1', pricePer1M: 3.3 })]);
  });
});

describe('costOf', () => {
  const at = d('2026-09-20');
  const rows = [row({ tokenType: 'input', pricePer1M: 3 }), row({ tokenType: 'output', pricePer1M: 15 })];

  it('prices input and output per 1M tokens and records which rows were used', () => {
    const c = costOf(rows, MANAGED_API_TIER, 'mid', { input: 1_000_000, output: 100_000 }, at, null, treatment);
    expect(c.inputCost).toBeCloseTo(3);
    expect(c.outputCost).toBeCloseTo(1.5);
    expect(c.totalCost).toBeCloseTo(4.5);
    expect(c.currency).toBe('USD');
    expect(c.refs.map((r) => r.tokenType)).toEqual(['input', 'output']);
    expect(c.missing).toEqual([]);
  });

  it('never charges cached or reasoning tokens twice: they are parts of input and output', () => {
    const c = costOf([...rows, row({ tokenType: 'cached_input', pricePer1M: 0.3 })], MANAGED_API_TIER, 'mid', { input: 1_000_000, cachedInput: 500_000, output: 200_000, reasoning: 100_000 }, at, null, treatment);
    // 0.5M × 3 + 0.5M × 0.3 ; 0.1M × 15 + 0.1M reasoning at output price 15
    expect(c.inputCost).toBeCloseTo(1.65);
    expect(c.outputCost).toBeCloseTo(3);
  });

  it('charges cached input at input × factor when no cached price is configured', () => {
    const c = costOf(rows, MANAGED_API_TIER, 'mid', { input: 1_000_000, cachedInput: 1_000_000, output: 0 }, at, null, { ...treatment, cachedInputPriceFactor: 0.5 });
    expect(c.inputCost).toBeCloseTo(1.5);
  });

  it('reports a missing price instead of guessing it', () => {
    const c = costOf([], 'acme', 'unknown', { input: 10, output: 10 }, at, null, treatment);
    expect(c.totalCost).toBeNull();
    expect(c.missing).toEqual(['input', 'output']);
    const partial = costOf(rows, MANAGED_API_TIER, 'mid', { input: 1_000_000, output: 0, reranking: 1000 }, at, null, treatment);
    expect(partial.totalCost).toBeCloseTo(3);
    expect(partial.missing).toEqual(['reranking']);
  });

  it('costs nothing when no tokens were used', () => {
    expect(costOf([], 'acme', 'unknown', { input: 0, output: 0 }, at, null, treatment).totalCost).toBe(0);
  });
});
