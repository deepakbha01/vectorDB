import { PriceTokenType } from './model-price.entity';
import { PriceRef } from './usage-event.entity';

/**
 * Versioned token pricing (spec §13) - pure functions, no I/O. The service
 * wraps these around the ai_model_prices table.
 */

export interface PricingTreatment {
  currency: string;
  catalogueEffectiveFrom: string;
  cachedInputPriceFactor: number;
  reasoningBilledAs: 'output' | 'input';
  prices: DesiredPrice[];
}

export interface DesiredPrice {
  provider: string;
  model: string;
  tokenType: PriceTokenType;
  pricePer1M: number;
  currency?: string;
  source: string;
  effectiveFrom?: string;
}

/** The fields of a price row these functions need. */
export interface PriceRow {
  id: string;
  projectId: string | null;
  provider: string;
  model: string;
  tokenType: PriceTokenType;
  pricePer1M: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
}

export const MANAGED_API_TIER = 'managed_api_tier';

const keyOf = (p: { provider: string; model: string; tokenType: string }) => `${p.provider}\u0000${p.model}\u0000${p.tokenType}`;

/** Catalogue prices from the existing config files plus the extra rows in token-observability.yaml. */
export function cataloguePrices(
  tiers: Array<{ id: string; label: string; inputPer1M: number; outputPer1M: number }>,
  embeddingProviders: Array<Record<string, any>>,
  treatment: PricingTreatment,
): DesiredPrice[] {
  const out: DesiredPrice[] = [];
  for (const t of tiers) {
    out.push({ provider: MANAGED_API_TIER, model: t.id, tokenType: 'input', pricePer1M: t.inputPer1M, source: `inference.yaml managedApiTiers: ${t.label} (list price)` });
    out.push({ provider: MANAGED_API_TIER, model: t.id, tokenType: 'output', pricePer1M: t.outputPer1M, source: `inference.yaml managedApiTiers: ${t.label} (list price)` });
  }
  for (const p of embeddingProviders) {
    for (const m of p.models ?? []) {
      if (typeof m.costPerMillionTokens !== 'number') continue;
      out.push({ provider: p.id, model: m.id, tokenType: 'embedding', pricePer1M: m.costPerMillionTokens, source: `embeddings.yaml: ${p.label} ${m.label}${m.lastVerifiedDate ? ` (verified ${m.lastVerifiedDate})` : ''}` });
    }
  }
  // Explicit rows win over the catalogue for the same key.
  const byKey = new Map(out.map((d) => [keyOf(d), d]));
  for (const d of treatment.prices ?? []) byKey.set(keyOf(d), d);
  return [...byKey.values()].map((d) => ({ ...d, currency: d.currency ?? treatment.currency }));
}

/**
 * What must change so the open catalogue rows (project = null) match the
 * desired prices. Never edits or deletes a row: a changed price closes the
 * open row at the moment the new one starts. Keys that disappeared from the
 * config are left open - removing a line is not a price change.
 */
export function planPriceSync(
  existing: PriceRow[],
  desired: DesiredPrice[],
  now: Date,
  catalogueEffectiveFrom: Date,
): { close: Array<{ id: string; effectiveTo: Date }>; insert: Array<DesiredPrice & { effectiveFrom: string; currency: string }> } {
  const global = existing.filter((r) => r.projectId === null);
  const close: Array<{ id: string; effectiveTo: Date }> = [];
  const insert: Array<DesiredPrice & { effectiveFrom: string; currency: string }> = [];
  for (const d of desired) {
    const rows = global.filter((r) => keyOf(r) === keyOf(d));
    const open = rows.find((r) => r.effectiveTo === null) ?? null;
    const currency = d.currency ?? 'USD';
    if (open && open.pricePer1M === d.pricePer1M && open.currency === currency) continue;
    // First sighting takes the configured effective date; a change takes effect now unless the config dates it.
    const start = d.effectiveFrom ? new Date(d.effectiveFrom) : rows.length ? now : catalogueEffectiveFrom;
    if (open) {
      if (start <= open.effectiveFrom) continue; // would overlap or reorder history - keep what exists
      close.push({ id: open.id, effectiveTo: start });
    }
    insert.push({ ...d, currency, effectiveFrom: start.toISOString() });
  }
  return { close, insert };
}

/** The row in force at `at`: a project override first, then the catalogue. */
export function resolvePrice(rows: PriceRow[], provider: string, model: string, tokenType: PriceTokenType, at: Date, projectId: string | null): PriceRow | null {
  const inForce = rows.filter(
    (r) => r.provider === provider && r.model === model && r.tokenType === tokenType && r.effectiveFrom <= at && (r.effectiveTo === null || at < r.effectiveTo),
  );
  const pick = (xs: PriceRow[]) => xs.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;
  return (projectId ? pick(inForce.filter((r) => r.projectId === projectId)) : null) ?? pick(inForce.filter((r) => r.projectId === null));
}

export interface TokenCounts {
  input: number;
  output: number;
  cachedInput?: number | null;
  reasoning?: number | null;
  embedding?: number;
  reranking?: number;
}

export interface CostBreakdown {
  inputCost: number | null;
  outputCost: number | null;
  totalCost: number | null;
  currency: string | null;
  refs: PriceRef[];
  /** Token types that were used but have no price - the cost is then incomplete, never guessed. */
  missing: PriceTokenType[];
}

/**
 * Cost of one call's tokens at the prices in force at `at`. `input` includes
 * cached input and `output` includes reasoning, as providers report them. Cached input is
 * charged as cached_input (or input × factor); reasoning as reasoning (or the
 * output price). Input-side cost covers input, cached input, embedding and
 * reranking; output-side covers output and reasoning.
 */
export function costOf(rows: PriceRow[], provider: string, model: string, t: TokenCounts, at: Date, projectId: string | null, treatment: Pick<PricingTreatment, 'cachedInputPriceFactor' | 'reasoningBilledAs'>): CostBreakdown {
  const refs: PriceRef[] = [];
  const missing: PriceTokenType[] = [];
  let currency: string | null = null;
  const use = (type: PriceTokenType, tokens: number, factor = 1, fallback?: PriceTokenType): number => {
    if (!tokens) return 0;
    let row = resolvePrice(rows, provider, model, type, at, projectId);
    let f = 1;
    if (!row && fallback) {
      row = resolvePrice(rows, provider, model, fallback, at, projectId);
      f = factor;
    }
    if (!row) {
      missing.push(type);
      return 0;
    }
    currency ??= row.currency;
    if (!refs.some((r) => r.id === row!.id)) refs.push({ id: row.id, tokenType: row.tokenType, pricePer1M: row.pricePer1M, effectiveFrom: row.effectiveFrom.toISOString() });
    return (tokens / 1e6) * row.pricePer1M * f;
  };
  const cached = t.cachedInput ?? 0;
  // Providers report cached tokens as part of input; charge them separately, never twice.
  const uncachedInput = Math.max(0, t.input - cached);
  const inputCost =
    use('input', uncachedInput) + use('cached_input', cached, treatment.cachedInputPriceFactor, 'input') + use('embedding', t.embedding ?? 0) + use('reranking', t.reranking ?? 0);
  // Likewise reasoning tokens are part of output (OTel gen_ai.usage.output_tokens).
  const reasoning = t.reasoning ?? 0;
  const outputCost = use('output', Math.max(0, t.output - reasoning)) + use('reasoning', reasoning, 1, treatment.reasoningBilledAs);
  const anyTokens = t.input + t.output + (t.embedding ?? 0) + (t.reranking ?? 0) > 0;
  if (!refs.length) return { inputCost: null, outputCost: null, totalCost: anyTokens ? null : 0, currency: null, refs, missing };
  return { inputCost, outputCost, totalCost: inputCost + outputCost, currency, refs, missing };
}
