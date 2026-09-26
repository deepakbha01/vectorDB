import { growthVsBaseline } from './usage-query';

/**
 * Token hotspots (validation spec §7): factual usage measurements over the
 * selected range and filters - never technology rankings. Pure: the service
 * supplies the aggregates. A hotspot nothing qualifies for says why instead
 * of showing a number.
 */

export type HotspotKey =
  | 'topApplication'
  | 'topService'
  | 'topModel'
  | 'tokensPerRequest'
  | 'fastestGrowth'
  | 'ragContextExpansion'
  | 'llmCallsPerRequest'
  | 'costPerRequest'
  | 'tokenSpike';

/** Where a click on the hotspot leads: filters to set, or a time window to narrow to. */
export type HotspotDrill = { dims: Partial<Record<'application' | 'service' | 'provider' | 'model', string>> } | { from: string; to: string };

export interface Hotspot {
  key: HotspotKey;
  title: string;
  /** What the hotspot is (a service, a model, an hour); null when nothing qualifies. */
  subject: string | null;
  value: number | null;
  unit: string;
  /** How the figure was measured, or why there is none. */
  detail: string;
  drill: HotspotDrill | null;
}

export interface ServiceUsage {
  applicationId: string | null;
  serviceId: string | null;
  requests: number;
  totalTokens: number;
  llmCalls: number;
  cost: number | null;
  unpricedEvents: number;
  /** Retrieved context at the generation stage, and the embedded query tokens. */
  contextTokens: number;
  queryTokens: number;
}

export interface HotspotInputs {
  applications: Array<{ applicationId: string | null; totalTokens: number }>;
  services: Array<{ applicationId: string | null; serviceId: string | null; totalTokens: number }>;
  models: Array<{ provider: string | null; model: string | null; totalTokens: number }>;
  perService: ServiceUsage[];
  /** Tokens per application / service in this window and in the equal window before it. */
  growth: Array<{ applicationId: string | null; serviceId: string | null; current: number; baseline: number }>;
  /** Hourly token totals from `baselineDays` before the range to its end, ascending. */
  hourly: Array<{ bucket: Date; tokens: number }>;
  range: { from: Date; to: Date };
  minRequests: number;
  spikeRule: { baselineDays: number; factor: number; minTokens: number };
}

const HOUR = 3_600_000;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function serviceLabel(s: { applicationId: string | null; serviceId: string | null }): string {
  if (s.serviceId && s.applicationId) return `${s.applicationId} / ${s.serviceId}`;
  return s.serviceId ?? s.applicationId ?? '(unattributed)';
}

function serviceDrill(s: { applicationId: string | null; serviceId: string | null }): HotspotDrill | null {
  const dims: Record<string, string> = {};
  if (s.applicationId) dims.application = s.applicationId;
  if (s.serviceId) dims.service = s.serviceId;
  return Object.keys(dims).length ? { dims } : null;
}

const none = (key: HotspotKey, title: string, unit: string, why: string): Hotspot => ({ key, title, subject: null, value: null, unit, detail: why, drill: null });

/** The highest value of `metric` among rows passing `eligible`. Ties keep the first (already token-ordered). */
function top<T>(rows: T[], metric: (r: T) => number | null, eligible: (r: T) => boolean = () => true): { row: T; value: number } | null {
  let best: { row: T; value: number } | null = null;
  for (const r of rows) {
    if (!eligible(r)) continue;
    const v = metric(r);
    if (v === null || !Number.isFinite(v)) continue;
    if (!best || v > best.value) best = { row: r, value: v };
  }
  return best;
}

/**
 * The hour in [from, to) that most exceeds its own baseline, by the spike
 * alert's rule: tokens >= minTokens and >= factor x the average hour of the
 * previous `baselineDays` (hours before the first usage do not count), with
 * at least a day of history behind it.
 */
export function findSpike(hourly: Array<{ bucket: Date; tokens: number }>, from: Date, to: Date, rule: HotspotInputs['spikeRule']): { bucket: Date; tokens: number; baselineHourly: number; ratio: number } | null {
  const used = hourly.filter((h) => h.tokens > 0);
  if (!used.length) return null;
  const first = Math.min(...used.map((h) => h.bucket.getTime()));
  const byHour = new Map(hourly.map((h) => [h.bucket.getTime(), h.tokens]));
  const window = rule.baselineDays * 24 * HOUR;
  let best: { bucket: Date; tokens: number; baselineHourly: number; ratio: number } | null = null;
  for (const h of hourly) {
    const t = h.bucket.getTime();
    if (t < from.getTime() || t >= to.getTime() || h.tokens < rule.minTokens) continue;
    const start = Math.max(first, t - window);
    const hours = (t - start) / HOUR;
    if (hours < 24) continue;
    let sum = 0;
    for (let x = start; x < t; x += HOUR) sum += byHour.get(x) ?? 0;
    const avg = sum / hours;
    if (avg <= 0 || h.tokens < avg * rule.factor) continue;
    const ratio = h.tokens / avg;
    if (!best || ratio > best.ratio) best = { bucket: h.bucket, tokens: h.tokens, baselineHourly: avg, ratio };
  }
  return best;
}

export function buildHotspots(x: HotspotInputs): Hotspot[] {
  const out: Hotspot[] = [];
  const enough = (s: ServiceUsage) => s.requests >= x.minRequests;
  const perRequestNote = `among applications / services with at least ${x.minRequests} requests`;

  // 1-3. Highest consumers (LLM tokens; embedding and reranking are listed separately in the tables).
  const app = top(x.applications, (r) => r.totalTokens, (r) => r.applicationId !== null && r.totalTokens > 0);
  out.push(
    app
      ? { key: 'topApplication', title: 'Highest token-consuming application', subject: app.row.applicationId, value: app.value, unit: 'tokens', detail: 'LLM input + output tokens in the range', drill: { dims: { application: app.row.applicationId! } } }
      : none('topApplication', 'Highest token-consuming application', 'tokens', 'No usage carries an application id.'),
  );
  const svc = top(x.services, (r) => r.totalTokens, (r) => (r.serviceId !== null || r.applicationId !== null) && r.totalTokens > 0);
  out.push(
    svc
      ? { key: 'topService', title: 'Highest token-consuming service', subject: serviceLabel(svc.row), value: svc.value, unit: 'tokens', detail: 'LLM input + output tokens in the range', drill: serviceDrill(svc.row) }
      : none('topService', 'Highest token-consuming service', 'tokens', 'No usage carries an application or service id.'),
  );
  const model = top(x.models, (r) => r.totalTokens, (r) => r.model !== null && r.totalTokens > 0);
  out.push(
    model
      ? {
          key: 'topModel',
          title: 'Highest token-consuming model',
          subject: model.row.provider ? `${model.row.provider} / ${model.row.model}` : model.row.model,
          value: model.value,
          unit: 'tokens',
          detail: 'LLM input + output tokens in the range',
          drill: { dims: { ...(model.row.provider ? { provider: model.row.provider } : {}), model: model.row.model! } },
        }
      : none('topModel', 'Highest token-consuming model', 'tokens', 'No LLM tokens in the range.'),
  );

  // 4. Highest tokens per request.
  const tpr = top(x.perService, (s) => s.totalTokens / s.requests, enough);
  out.push(
    tpr
      ? { key: 'tokensPerRequest', title: 'Highest tokens / request', subject: serviceLabel(tpr.row), value: Math.round(tpr.value), unit: 'tokens / request', detail: `${fmt(tpr.row.totalTokens)} tokens over ${fmt(tpr.row.requests)} requests, ${perRequestNote}`, drill: serviceDrill(tpr.row) }
      : none('tokensPerRequest', 'Highest tokens / request', 'tokens / request', `No application / service has ${x.minRequests} or more requests in the range.`),
  );

  // 5. Fastest token growth vs the previous window of equal length (same comparability rule as the growth card).
  const grown = top(
    x.growth.map((g) => ({ ...g, pct: growthVsBaseline(g.current, g.baseline).percent })),
    (g) => g.pct,
    (g) => g.pct !== null && g.pct > 0,
  );
  out.push(
    grown
      ? { key: 'fastestGrowth', title: 'Fastest token growth', subject: serviceLabel(grown.row), value: grown.value, unit: '% vs previous period', detail: `${fmt(grown.row.current)} tokens against ${fmt(grown.row.baseline)} in the equal period before`, drill: serviceDrill(grown.row) }
      : none('fastestGrowth', 'Fastest token growth', '% vs previous period', 'No application / service grew against a comparable previous period (it needs usage in both periods).'),
  );

  // 6. Largest RAG context expansion (retrieved context / query tokens).
  const rag = top(x.perService, (s) => (s.queryTokens > 0 ? s.contextTokens / s.queryTokens : null), (s) => s.contextTokens > 0);
  out.push(
    rag
      ? { key: 'ragContextExpansion', title: 'Largest RAG context expansion', subject: serviceLabel(rag.row), value: Math.round(rag.value * 10) / 10, unit: '× query tokens', detail: `${fmt(rag.row.contextTokens)} retrieved-context tokens for ${fmt(rag.row.queryTokens)} query tokens`, drill: serviceDrill(rag.row) }
      : none('ragContextExpansion', 'Largest RAG context expansion', '× query tokens', 'No events report both a query embedding and retrieved context (RAG stages).'),
  );

  // 7. Highest LLM calls per request.
  const calls = top(x.perService, (s) => s.llmCalls / s.requests, (s) => enough(s) && s.llmCalls > 0);
  out.push(
    calls
      ? { key: 'llmCallsPerRequest', title: 'Highest LLM calls / request', subject: serviceLabel(calls.row), value: Math.round(calls.value * 100) / 100, unit: 'LLM calls / request', detail: `${fmt(calls.row.llmCalls)} LLM calls over ${fmt(calls.row.requests)} requests, ${perRequestNote}`, drill: serviceDrill(calls.row) }
      : none('llmCallsPerRequest', 'Highest LLM calls / request', 'LLM calls / request', `No application / service with ${x.minRequests} or more requests made LLM calls.`),
  );

  // 8. Highest cost per request - only where every event was priced, so the figure is complete.
  const cost = top(x.perService, (s) => (s.cost === null ? null : s.cost / s.requests), (s) => enough(s) && s.unpricedEvents === 0 && s.cost !== null && s.cost > 0);
  out.push(
    cost
      ? { key: 'costPerRequest', title: 'Highest cost / request', subject: serviceLabel(cost.row), value: cost.value, unit: 'per request', detail: `${fmt(cost.row.requests)} requests, all priced, ${perRequestNote}`, drill: serviceDrill(cost.row) }
      : none('costPerRequest', 'Highest cost / request', 'per request', `No application / service with ${x.minRequests} or more requests has complete pricing.`),
  );

  // 9. Abnormal token spike.
  const spike = findSpike(x.hourly, x.range.from, x.range.to, x.spikeRule);
  out.push(
    spike
      ? {
          key: 'tokenSpike',
          title: 'Abnormal token spike',
          subject: spike.bucket.toISOString(),
          value: Math.round(spike.ratio * 10) / 10,
          unit: '× usual hourly volume',
          detail: `${fmt(spike.tokens)} tokens in one hour against an average of ${fmt(spike.baselineHourly)} per hour over up to ${x.spikeRule.baselineDays} days before it (spike alert rule: ${x.spikeRule.factor}×, at least ${fmt(x.spikeRule.minTokens)} tokens)`,
          drill: { from: spike.bucket.toISOString(), to: new Date(spike.bucket.getTime() + HOUR).toISOString() },
        }
      : none('tokenSpike', 'Abnormal token spike', '× usual hourly volume', `No hour reached ${x.spikeRule.factor}× its usual volume (and ${fmt(x.spikeRule.minTokens)} tokens) with at least a day of history behind it.`),
  );
  return out;
}
