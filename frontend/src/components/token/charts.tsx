import { ReactNode, useState } from 'react';
import { Theme, useTheme } from '../../theme';
import { TrendBucket } from '../../api/tokenObservability';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * Chart primitives for Token Observability. Text always uses ink tokens,
 * never a series color.
 *
 * VIZ is for HTML (CSS variables, so it follows the theme). SVG attributes do
 * not take CSS variables reliably, so the charts use literal palettes, one per
 * theme, validated with dataviz validate_palette.js:
 *  - dark: the theme's cobalt (blue-600) and cyan snapped into the dark band,
 *    --mode dark --surface #0e1726: all checks pass (CVD dE 18.5);
 *  - light: the reference palette slots 1-2, --mode light on white.
 */
export const VIZ = {
  series1: 'var(--chart-1)',
  series2: 'var(--chart-2)',
  muted: 'var(--muted)',
  ink2: 'var(--text-2)',
  ink: 'var(--text)',
  surface: 'var(--surface)',
};

const CHART: Record<Theme, { series1: string; series2: string; grid: string; axis: string; muted: string; ink2: string; surface: string; hover: string }> = {
  dark: { series1: '#2563eb', series2: '#0aa5bd', grid: '#1b2a4a', axis: '#2a3b5f', muted: '#94a3b8', ink2: '#cbd5e1', surface: '#0e1726', hover: 'rgba(59, 130, 246, 0.08)' },
  light: { series1: '#2a78d6', series2: '#eb6834', grid: '#e1e0d9', axis: '#c3c2b7', muted: '#898781', ink2: '#52514e', surface: '#ffffff', hover: 'rgba(11, 11, 11, 0.04)' },
};

/** The literal chart palette for the current theme. */
function useChart() {
  const c = CHART[useTheme().theme];
  return { ...c, tick: { fill: c.muted, fontSize: 11 } };
}

export const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const full = (n: number) => n.toLocaleString();
export const usd = (n: number | null, dp?: number) => (n === null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: dp ?? (Math.abs(n) < 1 ? 4 : 2), minimumFractionDigits: 0 })}`);

/** Card with a chart / table toggle - every chart has a table view (accessibility, exact values). */
export function ChartCard({ title, hint, table, children, action }: { title: string; hint?: string; table: { headers: string[]; rows: ReactNode[][] }; children: ReactNode; action?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          {title}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          {action}
          <button type="button" onClick={() => setAsTable((v) => !v)} style={linkBtn}>
            {asTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>
      {hint && <div style={{ fontSize: 12, color: VIZ.muted, marginTop: 2 }}>{hint}</div>}
      <div style={{ marginTop: 8 }}>{asTable ? <DataTable headers={table.headers} rows={table.rows} /> : children}</div>
    </div>
  );
}

export const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--primary-text)', cursor: 'pointer', fontSize: 12 };

export function DataTable({ headers, rows, onRow }: { headers: string[]; rows: ReactNode[][]; onRow?: (i: number) => void }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
          {headers.map((h, i) => (
            <th key={i} style={{ padding: '6px 8px', fontWeight: 600 }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} onClick={onRow ? () => onRow(i) : undefined} style={{ borderBottom: '1px solid var(--border)', cursor: onRow ? 'pointer' : undefined }}>
            {row.map((cell, j) => (
              <td key={j} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Tip({ active, payload, label, title, format }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string; title: (l: string) => string; format: (n: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: VIZ.surface, border: '1px solid var(--border)', boxShadow: 'var(--tooltip-shadow)', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: VIZ.ink }}>
      <div style={{ color: VIZ.ink2, marginBottom: 4 }}>{title(String(label))}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
            {p.name}
          </span>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{format(p.value)}</strong>
        </div>
      ))}
      {payload.length > 1 && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>Total</span>
          <strong>{format(payload.reduce((s, p) => s + p.value, 0))}</strong>
        </div>
      )}
      <div style={{ color: VIZ.muted, marginTop: 4 }}>Click to drill down</div>
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 12, color: VIZ.ink2, marginBottom: 4 }}>
      {items.map((i) => (
        <span key={i.label} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Buckets are UTC (weeks start on Monday); week and month labels are shown in UTC so they name the bucket, not a local shift of it. */
export const bucketLabel = (bucket: TrendBucket) => (iso: string) => {
  const d = new Date(iso);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (bucket === 'week') return `Wk of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
  return bucket === 'hour' ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** The end of the bucket that starts at `iso` - for drilling into it. */
export function bucketEnd(bucket: TrendBucket, iso: string): Date {
  const d = new Date(iso);
  if (bucket === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return new Date(d.getTime() + { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }[bucket]);
}

/** Input + output tokens per bucket, stacked (2 series, legend). Clicking a bucket narrows the range to it. */
export function TokenTrendChart({ points, bucket, onSelect }: { points: Array<{ bucket: string; inputTokens: number; outputTokens: number }>; bucket: TrendBucket; onSelect: (bucketIso: string) => void }) {
  const fmt = bucketLabel(bucket);
  const c = useChart();
  return (
    <>
      <Legend items={[{ label: 'Input tokens', color: c.series1 }, { label: 'Output tokens', color: c.series2 }]} />
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(s) => s?.activeLabel && onSelect(String(s.activeLabel))} style={{ cursor: 'pointer' }}>
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis dataKey="bucket" tickFormatter={fmt} stroke={c.axis} tick={c.tick} tickLine={false} minTickGap={24} />
          <YAxis tickFormatter={compact} tick={c.tick} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<Tip title={fmt} format={full} />} cursor={{ fill: c.hover }} />
          <Bar isAnimationActive={false} dataKey="inputTokens" name="Input" stackId="t" fill={c.series1} stroke={c.surface} strokeWidth={2} maxBarSize={28} />
          <Bar isAnimationActive={false} dataKey="outputTokens" name="Output" stackId="t" fill={c.series2} stroke={c.surface} strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

/** One series over time - a 2px line with a crosshair tooltip. */
export function LineTrendChart({ points, dataKey, name, bucket, format, onSelect }: { points: Array<Record<string, number | string>>; dataKey: string; name: string; bucket: TrendBucket; format: (n: number) => string; onSelect: (bucketIso: string) => void }) {
  const fmt = bucketLabel(bucket);
  const c = useChart();
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(s) => s?.activeLabel && onSelect(String(s.activeLabel))} style={{ cursor: 'pointer' }}>
        <CartesianGrid vertical={false} stroke={c.grid} />
        <XAxis dataKey="bucket" tickFormatter={fmt} stroke={c.axis} tick={c.tick} tickLine={false} minTickGap={24} />
        <YAxis tickFormatter={(n: number) => format(n)} tick={c.tick} axisLine={false} tickLine={false} width={56} />
        <Tooltip content={<Tip title={fmt} format={format} />} cursor={{ stroke: c.axis, strokeWidth: 1 }} />
        <Line type="linear" dataKey={dataKey} name={name} stroke={c.series1} strokeWidth={2} dot={points.length <= 2 ? { r: 4, fill: c.series1, stroke: c.surface, strokeWidth: 2 } : false} activeDot={{ r: 5, fill: c.series1, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Ranked single-series horizontal bars (one color - identity is the axis label). Clicking a bar filters to it. */
export function RankedBars({ rows, name, format, onSelect }: { rows: Array<{ key: string; label: string; value: number }>; name: string; format: (n: number) => string; onSelect: (key: string) => void }) {
  const data = rows.slice(0, 8);
  const c = useChart();
  return (
    <ResponsiveContainer width="100%" height={Math.max(80, data.length * 34 + 24)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} onClick={(s) => s?.activePayload?.[0] && onSelect((s.activePayload[0].payload as { key: string }).key)} style={{ cursor: 'pointer' }}>
        <CartesianGrid horizontal={false} stroke={c.grid} />
        <XAxis type="number" tickFormatter={(n: number) => format(n)} tick={c.tick} stroke={c.axis} tickLine={false} />
        <YAxis type="category" dataKey="label" tick={{ ...c.tick, fill: c.ink2 }} axisLine={false} tickLine={false} width={150} />
        <Tooltip content={<Tip title={(l) => l} format={format} />} cursor={{ fill: c.hover }} />
        <Bar isAnimationActive={false} dataKey="value" name={name} fill={c.series1} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
