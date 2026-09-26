import { useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../../api/client';
import {
  FILTER_NAMES,
  FilterName,
  Hotspot,
  RequestRow,
  TelemetryStatus,
  toParams,
  TrendBucket,
  UsageAgents,
  UsageCost,
  UsageDimensions,
  UsageFilters,
  UsageGroups,
  UsageHotspots,
  UsageRag,
  UsageRequests,
  UsageSummary,
  UsageTokens,
  UsageTrends,
} from '../../api/tokenObservability';
import { bucketEnd, ChartCard, compact, DataTable, full, LineTrendChart, linkBtn, RankedBars, TokenTrendChart, usd, VIZ } from './charts';
import { TraceView } from './TraceView';
import { download, toCsv } from './csv';

export type DashboardView = 'executive' | 'architect';

interface Data {
  summary: UsageSummary;
  tokens: UsageTokens;
  trends: UsageTrends;
  services: UsageGroups;
  models: UsageGroups;
  cost: UsageCost;
  rag: UsageRag;
  agents: UsageAgents;
  dims: UsageDimensions;
  hotspots: UsageHotspots;
}

const BUCKETS: Array<{ key: TrendBucket | 'auto'; label: string }> = [
  { key: 'auto', label: 'Auto' },
  { key: 'hour', label: 'Hourly' },
  { key: 'day', label: 'Daily' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
];
/** Hourly trends are limited server-side to 31 days. */
const MAX_HOURLY_MS = 31 * 86_400_000;

const TELEMETRY: Record<TelemetryStatus, { icon: string; label: string; color: string }> = {
  receiving: { icon: '●', label: 'Receiving live telemetry', color: 'var(--success)' },
  stale: { icon: '▲', label: 'Live telemetry has stopped', color: 'var(--warning)' },
  simulated_only: { icon: '◆', label: 'Simulated usage only - no live telemetry', color: 'var(--muted)' },
  no_telemetry: { icon: '○', label: 'No telemetry received yet', color: 'var(--muted)' },
};

const FILTER_LABELS: Record<FilterName, string> = { environment: 'Environment', application: 'Application', service: 'Service', workflow: 'Workflow', provider: 'Provider', model: 'Model', tenant: 'Tenant' };

const RANGES: Array<{ key: string; label: string; ms: number }> = [
  { key: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { key: '90d', label: 'Last 90 days', ms: 90 * 86_400_000 },
];
export const rangeFor = (key: string, now = new Date()) => {
  const r = RANGES.find((x) => x.key === key) ?? RANGES[2];
  return { from: new Date(now.getTime() - r.ms).toISOString(), to: now.toISOString() };
};

/**
 * Observed usage (simulated or live) - spec §4, §5, §19. Every aggregate
 * drills down: a bucket narrows the time range, a bar sets a filter, and
 * the requests list opens the trace behind any request.
 */
export function ObservedDashboard({ projectId, filters, rangeKey, view, onChange, refreshKey = 0 }: { projectId: string; filters: UsageFilters; rangeKey: string; view: DashboardView; onChange: (f: UsageFilters, rangeKey?: string) => void; refreshKey?: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<UsageRequests | null>(null);
  const [sort, setSort] = useState<'recent' | 'tokens' | 'cost'>('recent');
  const [agent, setAgent] = useState<string | undefined>();
  const [offset, setOffset] = useState(0);
  const [trace, setTrace] = useState<string | null>(null);
  const [bucket, setBucket] = useState<TrendBucket | 'auto'>('auto');
  const qs = toParams(filters);
  const hourlyAllowed = new Date(filters.to).getTime() - new Date(filters.from).getTime() <= MAX_HOURLY_MS;
  const trendBucket = bucket === 'hour' && !hourlyAllowed ? undefined : bucket === 'auto' ? undefined : bucket;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const get = <T,>(path: string, extra = '') => apiClient.get<T>(`/projects/${projectId}/token-observability/${path}?${qs}${extra}`).then((r) => r.data);
    Promise.all([
      get<UsageSummary>('summary'),
      get<UsageTokens>('tokens'),
      get<UsageTrends>('trends', trendBucket ? `&bucket=${trendBucket}` : ''),
      get<UsageGroups>('services'),
      get<UsageGroups>('models'),
      get<UsageCost>('cost'),
      get<UsageRag>('rag'),
      get<UsageAgents>('agents'),
      get<UsageDimensions>('dimensions'),
      get<UsageHotspots>('hotspots'),
    ])
      .then(([summary, tokens, trends, services, models, cost, rag, agents, dims, hotspots]) => active && setData({ summary, tokens, trends, services, models, cost, rag, agents, dims, hotspots }))
      .catch((e) => active && setError(extractErrorMessage(e, 'Could not load usage.')))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId, qs, refreshKey, trendBucket]);

  useEffect(() => setOffset(0), [qs, sort, agent]);
  useEffect(() => {
    let active = true;
    apiClient
      .get<UsageRequests>(`/projects/${projectId}/token-observability/requests?${toParams(filters, { sort, agent, offset, limit: 25 })}`)
      .then((r) => active && setRequests(r.data))
      .catch(() => active && setRequests(null));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, qs, sort, agent, offset, refreshKey]);

  const setDim = (patch: Partial<Record<FilterName, string | undefined>>) => {
    const dims = { ...filters.dims, ...patch };
    for (const k of Object.keys(dims) as FilterName[]) if (!dims[k]) delete dims[k];
    onChange({ ...filters, dims });
  };
  const drillToBucket = (iso: string) => {
    if (!data) return;
    onChange({ ...filters, from: new Date(iso).toISOString(), to: bucketEnd(data.trends.bucket, iso).toISOString() }, 'custom');
  };
  const drillToHotspot = (h: Hotspot) => {
    if (!h.drill) return;
    if ('dims' in h.drill) setDim(h.drill.dims);
    else onChange({ ...filters, from: h.drill.from, to: h.drill.to }, 'custom');
  };

  const s = data?.summary;
  const t = data?.tokens;
  const status = s ? TELEMETRY[s.telemetry.status] : null;
  const anyFilter = Object.keys(filters.dims).length > 0 || rangeKey === 'custom';

  const exportCsv = () => {
    if (!data) return;
    const d = data;
    const csv = toCsv([
      { title: `Token Observability - ${filters.mode} usage`, headers: ['From', 'To', ...FILTER_NAMES], rows: [[filters.from, filters.to, ...FILTER_NAMES.map((k) => filters.dims[k] ?? '')]] },
      {
        title: 'Summary',
        headers: ['Total tokens', 'Input tokens', 'Output tokens', 'Requests', 'Tokens / request', 'Cost', 'Cost incomplete', 'Growth vs baseline %'],
        rows: [[d.summary.cards.totalTokens, d.summary.cards.inputTokens, d.summary.cards.outputTokens, d.summary.cards.requests, d.summary.cards.tokensPerRequest, d.summary.cards.cost, d.summary.cards.costIncomplete, d.summary.cards.growthVsBaselinePercent]],
      },
      { title: 'By service', headers: ['Application', 'Service', 'Workflow', 'Total tokens', 'Input', 'Output', 'Embedding', 'Cost', 'Share %'], rows: d.services.rows.map((r) => [r.applicationId, r.serviceId, r.workflowId, r.totalTokens, r.inputTokens, r.outputTokens, r.embeddingTokens, r.cost, r.share]) },
      { title: 'By model', headers: ['Provider', 'Model', 'Total tokens', 'Input', 'Output', 'Embedding', 'Cost', 'Share %'], rows: d.models.rows.map((r) => [r.provider, r.model, r.totalTokens, r.inputTokens, r.outputTokens, r.embeddingTokens, r.cost, r.share]) },
      { title: 'Hotspots', headers: ['Hotspot', 'Subject', 'Value', 'Unit', 'Detail'], rows: d.hotspots.hotspots.map((h) => [h.title, h.subject, h.value, h.unit, h.detail]) },
      {
        title: 'Task outcomes',
        headers: ['Requests', 'Successful tasks', 'Success rate %', 'Tokens / successful task', 'Cost / request', 'Cost / successful task'],
        rows: [[d.tokens.requests, d.tokens.successfulTasks, d.tokens.taskSuccessRatePercent, d.tokens.tokensPerSuccessfulTask, d.cost.costPerRequest, d.cost.costPerSuccessfulTask]],
      },
      { title: `Trend (per ${d.trends.bucket})`, headers: ['Bucket', 'Input', 'Output', 'Total', 'Cost'], rows: d.trends.points.map((p) => [p.bucket, p.inputTokens, p.outputTokens, p.totalTokens, p.cost]) },
      {
        title: 'Cost',
        headers: ['Observed cost', 'Monthly run rate', 'Estimate (monthly)', 'Delta vs estimate %', 'Budget (monthly)', 'Budget used %', 'Unpriced events'],
        rows: [[d.cost.observedCost, d.cost.forecast.monthlyRunRate, d.cost.estimate?.monthlyUsd, d.cost.estimate?.deltaPercent, d.cost.budget?.monthlyUsd, d.cost.budget?.shareUsed, d.cost.unpricedEvents]],
      },
    ]);
    download(`token-observability-${filters.mode}-${filters.from.slice(0, 10)}-${filters.to.slice(0, 10)}.csv`, csv);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16, maxWidth: 1250 }}>
      {/* Filters: one row above the charts (spec §4, §19). */}
      <div className="card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <select value={rangeKey} onChange={(e) => e.target.value !== 'custom' && onChange({ ...filters, ...rangeFor(e.target.value) }, e.target.value)} aria-label="Time range">
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
          {rangeKey === 'custom' && <option value="custom">{`${new Date(filters.from).toLocaleString()} – ${new Date(filters.to).toLocaleString()}`}</option>}
        </select>
        {FILTER_NAMES.map((k) => {
          const values = data?.dims.values[k] ?? [];
          if (!values.length && !filters.dims[k]) return null;
          return (
            <select key={k} value={filters.dims[k] ?? ''} onChange={(e) => setDim({ [k]: e.target.value || undefined })} aria-label={FILTER_LABELS[k]}>
              <option value="">{`All ${FILTER_LABELS[k].toLowerCase()}s`}</option>
              {[...new Set([...(filters.dims[k] ? [filters.dims[k]!] : []), ...values])].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        })}
        {anyFilter && (
          <button type="button" style={linkBtn} onClick={() => onChange({ ...filters, ...rangeFor('30d'), dims: {} }, '30d')}>
            Clear filters
          </button>
        )}
        <span style={{ flex: 1 }} />
        {loading && <span style={{ color: VIZ.muted }}>Loading…</span>}
        <button type="button" className="primary-btn" style={{ padding: '6px 12px', fontSize: 13 }} onClick={exportCsv} disabled={!data}>
          Export CSV
        </button>
      </div>

      {error && <div className="card error-text">{error}</div>}
      {status && (
        <div style={{ fontSize: 13, color: VIZ.ink2 }}>
          <span style={{ color: status.color }}>{status.icon}</span> {status.label}
          {s?.telemetry.lastLive && ` · last live event ${new Date(s.telemetry.lastLive).toLocaleString()}`}
          {s?.telemetry.lastSimulated && filters.mode === 'simulated' && ` · last simulated event ${new Date(s.telemetry.lastSimulated).toLocaleString()}`}
        </div>
      )}

      {data && s?.empty && (
        <div className="card" style={{ borderLeft: '4px solid var(--muted)' }}>
          <strong>No {filters.mode} usage for this range and filters.</strong>
          <div style={{ fontSize: 13, color: VIZ.ink2, marginTop: 4 }}>
            Nothing is shown rather than estimated. {filters.mode === 'live' ? 'Live usage appears once an application sends usage events.' : 'Simulated usage appears once load-test or benchmark results are uploaded.'} Switch to <em>Estimated</em> to see the projection.
          </div>
        </div>
      )}

      {data && s && t && !s.empty && (
        <>
          {/* Spec §5 executive cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Stat label="Total tokens" value={compact(s.cards.totalTokens)} sub={`${full(s.cards.totalTokens)} observed`} />
            <Stat label="Input tokens" value={compact(s.cards.inputTokens)} />
            <Stat label="Output tokens" value={compact(s.cards.outputTokens)} />
            <Stat label="Requests" value={compact(s.cards.requests)} />
            <Stat label="Tokens / request" value={s.cards.tokensPerRequest !== null ? full(s.cards.tokensPerRequest) : '—'} sub={t.llmCallsPerRequest !== null ? `${t.llmCallsPerRequest} LLM calls / request` : undefined} />
            <Stat label="Actual cost" value={usd(s.cards.cost)} sub={s.cards.costIncomplete ? `▲ incomplete - ${data.cost.unpricedEvents} event(s) without a price` : 'at prices in force when used'} />
            <Stat label="Top token consumer" value={s.cards.topConsumer ? s.cards.topConsumer.service ?? s.cards.topConsumer.application ?? '(unattributed)' : '—'} sub={s.cards.topConsumer ? `${compact(s.cards.topConsumer.totalTokens)} tokens` : undefined} />
            <Stat
              label="Growth vs baseline"
              value={s.cards.growthVsBaselinePercent === null ? '—' : `${s.cards.growthVsBaselinePercent > 0 ? '+' : ''}${s.cards.growthVsBaselinePercent}%`}
              sub={s.cards.growthNote ?? `vs ${compact(s.cards.baselineTotalTokens)} in the previous period`}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 16 }}>
            <ChartCard
              title={`Token trend (per ${data.trends.bucket})`}
              hint={data.trends.bucket === 'week' || data.trends.bucket === 'month' ? 'UTC; weeks start on Monday. The first and last bars can be partial. Click a bar to narrow the range to it.' : 'Click a bar to narrow the range to it.'}
              action={
                <select value={bucket} onChange={(e) => setBucket(e.target.value as TrendBucket | 'auto')} aria-label="Trend bucket" style={{ fontSize: 12 }}>
                  {BUCKETS.map((b) => (
                    <option key={b.key} value={b.key} disabled={b.key === 'hour' && !hourlyAllowed}>
                      {b.label}
                      {b.key === 'hour' && !hourlyAllowed ? ' (31 days max)' : ''}
                    </option>
                  ))}
                </select>
              }
              table={{ headers: ['Bucket', 'Input', 'Output', 'Total'], rows: data.trends.points.map((p) => [new Date(p.bucket).toLocaleString(), full(p.inputTokens), full(p.outputTokens), full(p.totalTokens)]) }}
            >
              <TokenTrendChart points={data.trends.points} bucket={data.trends.bucket} onSelect={drillToBucket} />
            </ChartCard>
            <CostCard cost={data.cost} trends={data.trends} onSelect={drillToBucket} />
          </div>

          <HotspotsCard hotspots={data.hotspots} onSelect={drillToHotspot} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 16 }}>
            <ChartCard
              title="Consumption by application / service"
              hint="Click a bar to filter to that service."
              table={{ headers: ['Application', 'Service', 'Workflow', 'Tokens', 'Share', 'Cost'], rows: data.services.rows.map((r) => [r.applicationId ?? '—', r.serviceId ?? '—', r.workflowId ?? '—', full(r.totalTokens), `${r.share}%`, usd(r.cost, 2)]) }}
            >
              <RankedBars
                name="Tokens"
                rows={data.services.rows.map((r, i) => ({ key: String(i), label: r.serviceId ?? r.applicationId ?? '(unattributed)', value: r.totalTokens }))}
                format={compact}
                onSelect={(k) => {
                  const r = data.services.rows[Number(k)];
                  setDim({ application: r.applicationId ?? undefined, service: r.serviceId ?? undefined });
                }}
              />
            </ChartCard>
            <ChartCard
              title="Consumption by model / provider"
              hint="LLM tokens; embedding tokens are in the table. Click a bar to filter to that model."
              table={{ headers: ['Provider', 'Model', 'LLM tokens', 'Embedding', 'Share', 'Avg latency', 'Cost'], rows: data.models.rows.map((r) => [r.provider ?? '—', r.model ?? '—', full(r.totalTokens), full(r.embeddingTokens), `${r.share}%`, r.avgLatencyMs != null ? `${full(r.avgLatencyMs)} ms` : '—', usd(r.cost, 2)]) }}
            >
              <RankedBars
                name="LLM tokens"
                rows={data.models.rows.filter((r) => r.totalTokens > 0).map((r) => ({ key: `${r.provider}\u0000${r.model}`, label: `${r.model}`, value: r.totalTokens }))}
                format={compact}
                onSelect={(k) => {
                  const [provider, model] = k.split('\u0000');
                  setDim({ provider, model });
                }}
              />
            </ChartCard>
          </div>

          {view === 'architect' && (
            <>
              <Efficiency t={t} rag={data.rag} cost={data.cost} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(600px, 1fr))', gap: 16 }}>
                <RagCard rag={data.rag} />
                <AgentCard agents={data.agents} selected={agent} onSelect={(a) => setAgent(a === agent ? undefined : a)} />
              </div>
            </>
          )}

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <div className="metric-label" style={{ marginBottom: 0 }}>
                Requests{agent ? ` · agent ${agent}` : ''} - click one to open its trace
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
                {agent && (
                  <button type="button" style={linkBtn} onClick={() => setAgent(undefined)}>
                    All agents
                  </button>
                )}
                <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort requests">
                  <option value="recent">Newest first</option>
                  <option value="tokens">Most tokens (hotspots)</option>
                  <option value="cost">Most expensive</option>
                </select>
              </div>
            </div>
            {requests && (
              <>
                <DataTable
                  headers={['Started', 'Service', 'Models', 'LLM tokens', 'Calls', 'Cost', '']}
                  rows={requests.rows.map((r: RequestRow) => [
                    new Date(r.started).toLocaleString(),
                    r.serviceId ?? r.applicationId ?? '—',
                    <span key="m" style={{ fontSize: 12, color: VIZ.ink2 }}>{r.models}</span>,
                    full(r.totalTokens),
                    `${r.llmCalls} LLM · ${r.toolCalls} tool`,
                    r.costIncomplete ? <span key="c" style={{ color: 'var(--warning)' }}>{usd(r.cost, 6)} (incomplete)</span> : usd(r.cost, 6),
                    r.failed ? <span key="f" style={{ color: 'var(--danger)' }}>▲ error</span> : '',
                  ])}
                  onRow={(i) => setTrace(requests.rows[i].traceId ?? requests.rows[i].request)}
                />
                <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12 }}>
                  {offset > 0 && (
                    <button type="button" style={linkBtn} onClick={() => setOffset(Math.max(0, offset - 25))}>
                      ← Previous
                    </button>
                  )}
                  {requests.hasMore && (
                    <button type="button" style={linkBtn} onClick={() => setOffset(offset + 25)}>
                      Next →
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {trace && <TraceView projectId={projectId} traceId={trace} onClose={() => setTrace(null)} />}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: VIZ.ink2 }}>{sub}</div>}
    </div>
  );
}

function CostCard({ cost, trends, onSelect }: { cost: UsageCost; trends: UsageTrends; onSelect: (iso: string) => void }) {
  const delta = cost.estimate?.deltaPercent;
  return (
    <ChartCard
      title={`Cost trend (${cost.currency}, per ${trends.bucket})`}
      hint="Priced at the version in force when each call was made."
      table={{ headers: ['Bucket', 'Cost'], rows: trends.points.map((p) => [new Date(p.bucket).toLocaleString(), usd(p.cost, 4)]) }}
    >
      <LineTrendChart points={trends.points as unknown as Array<Record<string, number | string>>} dataKey="cost" name="Cost" bucket={trends.bucket} format={(n) => usd(n, n < 10 ? 4 : 0)} onSelect={onSelect} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, fontSize: 13, marginTop: 8 }}>
        <div>
          <div className="metric-label">Monthly run rate</div>
          {usd(cost.forecast.monthlyRunRate, 2)}
          <div style={{ fontSize: 11, color: VIZ.muted }}>{cost.forecast.basis}</div>
        </div>
        <div>
          <div className="metric-label">{cost.estimate ? `Estimate (v${cost.estimate.version})` : 'Estimate'}</div>
          {cost.estimate ? usd(cost.estimate.monthlyUsd, 2) : <span style={{ color: VIZ.ink2 }}>No saved estimate</span>}
          {delta != null && (
            <div style={{ fontSize: 12, color: VIZ.ink2 }}>
              {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}% {delta > 0 ? 'above' : 'below'} estimate
            </div>
          )}
        </div>
        <div>
          <div className="metric-label">Cost / request</div>
          {usd(cost.costPerRequest, 6)}
        </div>
        <div>
          <div className="metric-label">Cost / successful task</div>
          {usd(cost.costPerSuccessfulTask, 6)}
          <div style={{ fontSize: 11, color: VIZ.muted }}>failed attempts included</div>
        </div>
        <div>
          <div className="metric-label">Budget</div>
          {cost.budget ? `${usd(cost.budget.monthlyUsd, 0)} · ${cost.budget.shareUsed ?? '—'}% at run rate` : 'No budget recorded'}
        </div>
      </div>
      {cost.costIncomplete && <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 6 }}>▲ {cost.unpricedEvents} event(s) had no price in force - add the price to include them.</div>}
    </ChartCard>
  );
}

/** Validation spec §7: factual measurements, never rankings of technology. Each row drills into what it names. */
function HotspotsCard({ hotspots, onSelect }: { hotspots: UsageHotspots; onSelect: (h: Hotspot) => void }) {
  const value = (h: Hotspot) => {
    if (h.value === null) return <span style={{ color: VIZ.muted }}>—</span>;
    if (h.unit === 'per request') return `${usd(h.value, 6)} / request`;
    if (h.unit.startsWith('%')) return `+${h.value}% vs previous period`;
    if (h.unit.startsWith('×')) return `${h.value}${h.unit}`;
    return `${full(h.value)} ${h.unit}`;
  };
  const subject = (h: Hotspot) => (h.key === 'tokenSpike' && h.subject ? new Date(h.subject).toLocaleString() : h.subject);
  return (
    <div className="card">
      <div className="metric-label">Token hotspots - measured in this range and filters; click one to drill in</div>
      <DataTable
        headers={['Hotspot', 'Where', 'Measured', 'How']}
        rows={hotspots.hotspots.map((h) => [
          h.title,
          h.subject !== null ? <strong key="s">{subject(h)}</strong> : <span key="s" style={{ color: VIZ.muted }}>none</span>,
          value(h),
          <span key="d" style={{ fontSize: 12, color: VIZ.muted }}>{h.detail}</span>,
        ])}
        onRow={(i) => onSelect(hotspots.hotspots[i])}
      />
    </div>
  );
}

function Efficiency({ t, rag, cost }: { t: UsageTokens; rag: UsageRag; cost: UsageCost }) {
  const x = t.totals;
  const failedTokens = x.totalTokens - t.successfulRequestTokens;
  const rows: Array<[string, string, string]> = [
    ['Tokens / request', t.tokensPerRequest !== null ? full(Math.round(t.tokensPerRequest)) : '—', 'LLM input + output'],
    ['Tokens / successful task', t.tokensPerSuccessfulTask !== null ? full(t.tokensPerSuccessfulTask) : '—', 'all tokens, failed attempts included, per task that succeeded'],
    ['Task success rate', t.taskSuccessRatePercent !== null ? `${t.taskSuccessRatePercent}%` : '—', `${full(t.successfulTasks)} of ${full(t.requests)} tasks had no failed step`],
    ['LLM calls / request', t.llmCallsPerRequest !== null ? String(t.llmCallsPerRequest) : '—', 'more than 1 means chaining or an agent'],
    ['Tool calls / request', t.toolCallsPerRequest !== null ? String(t.toolCallsPerRequest) : '—', ''],
    ['Output : input', x.inputTokens ? `1 : ${(x.inputTokens / Math.max(1, x.outputTokens)).toFixed(1)}` : '—', 'how much prompt each answer token needs'],
    ['Cached input share', x.inputTokens ? `${((x.cachedInputTokens / x.inputTokens) * 100).toFixed(1)}%` : '—', 'input served from the provider cache'],
    ['Reasoning share of output', x.outputTokens ? `${((x.reasoningTokens / x.outputTokens) * 100).toFixed(1)}%` : '—', ''],
    ['Context expansion ratio', rag.contextExpansionRatio !== null ? `${rag.contextExpansionRatio}×` : '—', 'retrieved context / query tokens'],
    ['Tokens in failed requests', `${compact(failedTokens)} (${x.totalTokens ? ((failedTokens / x.totalTokens) * 100).toFixed(1) : 0}%)`, `${t.errors} error span(s)`],
    ['Cost / 1K tokens', x.totalTokens && cost.observedCost !== null ? usd((cost.observedCost / x.totalTokens) * 1000, 5) : '—', ''],
    ['Latency (LLM calls)', t.latencyMs.avg !== null ? `avg ${full(Math.round(t.latencyMs.avg))} ms · p95 ${full(Math.round(t.latencyMs.p95 ?? 0))} ms` : '—', ''],
    ['Time to first token', t.ttftMs.avg !== null ? `avg ${full(Math.round(t.ttftMs.avg))} ms` : '—', 'where reported'],
  ];
  return (
    <div className="card">
      <div className="metric-label">Token efficiency</div>
      <DataTable headers={['Metric', 'Value', '']} rows={rows.map(([a, b, c]) => [a, <strong key="v">{b}</strong>, <span key="c" style={{ fontSize: 12, color: VIZ.muted }}>{c}</span>])} />
    </div>
  );
}

function RagCard({ rag }: { rag: UsageRag }) {
  if (rag.empty) {
    return (
      <div className="card">
        <div className="metric-label">RAG token breakdown</div>
        <p style={{ fontSize: 13, color: VIZ.ink2 }}>No events carry a RAG stage in this range.</p>
      </div>
    );
  }
  const p = rag.perRequest;
  return (
    <ChartCard
      title={`RAG token breakdown (${full(rag.requests)} requests)`}
      table={{ headers: ['Stage', 'Events', 'Input', 'Output', 'Embedding', 'Rerank', 'Context', 'Chunks'], rows: rag.stages.map((s) => [s.stage, full(s.events), full(s.inputTokens), full(s.outputTokens), full(s.embeddingTokens), full(s.rerankingTokens), full(s.contextTokens), full(s.retrievalCount)]) }}
    >
      {p && (
        <DataTable
          headers={['Per request', 'Tokens']}
          rows={[
            ['Query embedding', full(Math.round(p.queryEmbeddingTokens))],
            ['Chunks retrieved', full(Math.round(p.retrievedChunks))],
            ['Reranking', full(Math.round(p.rerankingTokens))],
            ['Retrieved context', full(Math.round(p.contextTokens))],
            ['Final LLM input', full(Math.round(p.finalInputTokens))],
            ['LLM output', full(Math.round(p.outputTokens))],
            [<strong key="c">Context expansion ratio</strong>, <strong key="v">{rag.contextExpansionRatio !== null ? `${rag.contextExpansionRatio}×` : '—'}</strong>],
          ]}
        />
      )}
    </ChartCard>
  );
}

function AgentCard({ agents, selected, onSelect }: { agents: UsageAgents; selected?: string; onSelect: (agentId: string) => void }) {
  if (!agents.agents.length) {
    return (
      <div className="card">
        <div className="metric-label">Agent token breakdown</div>
        <p style={{ fontSize: 13, color: VIZ.ink2 }}>No agent activity in this range.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="metric-label">Agent token breakdown - click an agent to list its tasks</div>
      <DataTable
        headers={['Agent', 'Tasks', 'LLM / task', 'Tool / task', 'Tokens / task', 'Cost / task', 'Loop check']}
        rows={agents.agents.map((a) => [
          <strong key="a" style={{ textDecoration: a.agentId === selected ? 'underline' : undefined }}>{a.agentId}</strong>,
          full(a.tasks),
          a.llmCallsPerTask.toFixed(1),
          a.toolCallsPerTask.toFixed(1),
          full(a.tokensPerTask),
          a.costIncomplete ? `${usd(a.costPerTask, 5)} (incomplete)` : usd(a.costPerTask, 5),
          a.tasksOverLimit ? <span key="l" style={{ color: 'var(--warning)' }}>▲ {a.tasksOverLimit} task(s) over {agents.loopThreshold} LLM calls</span> : <span key="l" style={{ color: VIZ.ink2 }}>● max {a.maxLlmCallsPerTask} calls</span>,
        ])}
        onRow={(i) => onSelect(agents.agents[i].agentId)}
      />
      {agents.agents
        .filter((a) => a.agentId === selected)
        .map((a) => (
          <div key={a.agentId} style={{ marginTop: 10 }}>
            <div className="metric-label">Tokens by step - {a.agentId}</div>
            <DataTable headers={['Step', 'Calls', 'Input', 'Output', 'Avg latency']} rows={a.steps.map((st) => [st.toolName ? `${st.operationType} · ${st.toolName}` : st.operationType, full(st.calls), full(st.inputTokens), full(st.outputTokens), st.avgLatencyMs !== null ? `${full(Math.round(st.avgLatencyMs))} ms` : '—'])} />
          </div>
        ))}
    </div>
  );
}
