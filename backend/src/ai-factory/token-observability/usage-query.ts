import { UsageQueryDto } from './dto/usage-query.dto';
import { ObservedSource } from './usage-event.entity';

/** Query helpers for observed usage - pure, no I/O. */

const DAY_MS = 86_400_000;
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 400;

/** Filter name → column (same name in ai_usage_events and ai_usage_rollups). */
export const FILTER_COLUMNS = {
  environment: 'environment',
  application: 'applicationId',
  service: 'serviceId',
  model: 'model',
  provider: 'provider',
  tenant: 'tenantId',
  workflow: 'workflowId',
} as const;
export type FilterName = keyof typeof FILTER_COLUMNS;

export interface UsageFilters {
  from: Date;
  to: Date;
  mode: ObservedSource;
  bucket: 'hour' | 'day';
  dims: Partial<Record<FilterName, string>>;
}

export function resolveFilters(q: UsageQueryDto, now: Date): UsageFilters | { error: string } {
  const to = q.to ? new Date(q.to) : now;
  const requested = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  // Whole hours, as the hourly totals are kept, so totals (rollups) and request counts (events) cover the same window.
  const from = new Date(Math.floor(requested.getTime() / 3_600_000) * 3_600_000);
  if (from >= to) return { error: '`from` must be before `to`.' };
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) return { error: `The time range may span at most ${MAX_RANGE_DAYS} days.` };
  const dims = Object.fromEntries((Object.keys(FILTER_COLUMNS) as FilterName[]).filter((k) => q[k]).map((k) => [k, q[k]!])) as UsageFilters['dims'];
  return { from, to, mode: q.mode ?? 'live', bucket: q.bucket ?? (to.getTime() - from.getTime() > 3 * DAY_MS ? 'day' : 'hour'), dims };
}

/**
 * WHERE clause for one project's usage. Rollups are hourly, so their range is
 * widened to whole hours; events use exact timestamps. Parameters start at $1
 * and the caller appends its own after `params.length`.
 */
export function whereClause(projectId: string, f: UsageFilters, table: 'events' | 'rollups', alias = 't'): { sql: string; params: unknown[] } {
  const time = table === 'events' ? '"timestamp"' : '"bucketStart"';
  // f.from is already a whole hour (resolveFilters), so events and rollups share the window.
  const params: unknown[] = [projectId, f.mode, f.from, f.to];
  const parts = [`${alias}."projectId" = $1`, `${alias}."telemetrySource" = $2`, `${alias}.${time} >= $3`, `${alias}.${time} < $4`];
  for (const [name, value] of Object.entries(f.dims) as Array<[FilterName, string]>) {
    params.push(value);
    parts.push(`${alias}."${FILTER_COLUMNS[name]}" = $${params.length}`);
  }
  return { sql: parts.join(' AND '), params };
}

/** The same filters over the preceding window of equal length - the "baseline" for growth. */
export function previousWindow(f: UsageFilters): UsageFilters {
  const span = f.to.getTime() - f.from.getTime();
  return { ...f, from: new Date(f.from.getTime() - span), to: f.from };
}

export function growth(current: number, baseline: number): number | null {
  return baseline > 0 ? Math.round(((current - baseline) / baseline) * 1000) / 10 : null;
}

/** Growth vs the previous window, withheld when that window had too little usage to compare (under 10% of now). */
export function growthVsBaseline(current: number, baseline: number): { percent: number | null; note: string | null } {
  if (baseline <= 0) return { percent: null, note: 'no usage in the previous period' };
  if (baseline < current * 0.1) return { percent: null, note: 'too little usage in the previous period to compare' };
  return { percent: growth(current, baseline), note: null };
}

export function withShare<T extends { totalTokens: number }>(rows: T[]): Array<T & { share: number }> {
  const total = rows.reduce((s, r) => s + r.totalTokens, 0);
  return rows.map((r) => ({ ...r, share: total ? Math.round((r.totalTokens / total) * 1000) / 10 : 0 }));
}

// ------------------------------------------------------------------ traces

export interface SpanRow {
  eventId: string;
  timestamp: Date;
  spanId: string | null;
  parentSpanId: string | null;
  operationType: string;
  provider: string;
  model: string;
  agentId: string | null;
  toolName: string | null;
  ragStage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  embeddingTokens: number;
  rerankingTokens: number;
  llmCallCount: number;
  toolCallCount: number;
  latencyMs: number | null;
  ttftMs: number | null;
  requestStatus: string;
  errorType: string | null;
  estimatedTotalCost: number | null;
}

export type SpanNode = SpanRow & { children: SpanNode[] };

/**
 * The agent → LLM → tool → LLM tree of one trace (spec §9). Spans whose
 * parent is not in the trace become roots, so a partial trace still shows.
 */
export function buildTrace(rows: SpanRow[], loopThreshold: number) {
  const sorted = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const nodes = new Map<string, SpanNode>();
  const all: SpanNode[] = sorted.map((r) => ({ ...r, children: [] }));
  for (const n of all) if (n.spanId) nodes.set(n.spanId, n);
  const roots: SpanNode[] = [];
  for (const n of all) {
    const parent = n.parentSpanId ? nodes.get(n.parentSpanId) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  const llmCalls = sum(all.map((n) => n.llmCallCount));
  const toolCalls = new Map<string, number>();
  for (const n of all) if (n.toolName && n.toolCallCount) toolCalls.set(n.toolName, (toolCalls.get(n.toolName) ?? 0) + n.toolCallCount);
  const repeatedTools = [...toolCalls.entries()].filter(([, c]) => c >= 3).map(([tool, calls]) => ({ tool, calls }));
  const priced = all.filter((n) => n.estimatedTotalCost !== null);
  const start = sorted[0]?.timestamp.getTime() ?? 0;
  const end = Math.max(...sorted.map((n) => n.timestamp.getTime() + (n.latencyMs ?? 0)), start);
  return {
    spans: all.length,
    roots,
    totals: {
      inputTokens: sum(all.map((n) => n.inputTokens)),
      outputTokens: sum(all.map((n) => n.outputTokens)),
      totalTokens: sum(all.map((n) => n.totalTokens)),
      embeddingTokens: sum(all.map((n) => n.embeddingTokens)),
      rerankingTokens: sum(all.map((n) => n.rerankingTokens)),
      llmCalls,
      toolCalls: sum(all.map((n) => n.toolCallCount)),
      costUsd: priced.length ? sum(priced.map((n) => n.estimatedTotalCost!)) : null,
      unpricedSpans: all.length - priced.length,
      durationMs: end - start,
      errors: all.filter((n) => n.requestStatus === 'error').length,
    },
    loop: {
      threshold: loopThreshold,
      excessiveLlmCalls: llmCalls > loopThreshold,
      repeatedTools,
    },
  };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
