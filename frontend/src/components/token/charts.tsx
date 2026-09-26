import { ReactNode, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * Chart primitives for Token Observability. Colors are the validated
 * reference palette (slots 1-2, checked against the app's white surface);
 * text always uses ink tokens, never a series color.
 */
export const VIZ = {
  series1: '#2a78d6',
  series2: '#eb6834',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  ink2: '#52514e',
  ink: '#0b0b0b',
  surface: '#ffffff',
  hover: 'rgba(11, 11, 11, 0.04)',
};

export const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const full = (n: number) => n.toLocaleString();
export const usd = (n: number | null, dp?: number) => (n === null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: dp ?? (Math.abs(n) < 1 ? 4 : 2), minimumFractionDigits: 0 })}`);

const AXIS_TICK = { fill: VIZ.muted, fontSize: 11 };

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

export const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: '#2f5fd0', cursor: 'pointer', fontSize: 12 };

export function DataTable({ headers, rows, onRow }: { headers: string[]; rows: ReactNode[][]; onRow?: (i: number) => void }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
          {headers.map((h, i) => (
            <th key={i} style={{ padding: '6px 8px', fontWeight: 600 }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} onClick={onRow ? () => onRow(i) : undefined} style={{ borderBottom: '1px solid #eceff3', cursor: onRow ? 'pointer' : undefined }}>
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
    <div style={{ background: VIZ.surface, border: '1px solid rgba(11,11,11,0.10)', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: VIZ.ink, boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
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
        <div style={{ borderTop: '1px solid #eceff3', marginTop: 4, paddingTop: 4, display: 'flex', justifyContent: 'space-between' }}>
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

const bucketLabel = (bucket: 'hour' | 'day') => (iso: string) => {
  const d = new Date(iso);
  return bucket === 'hour' ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Input + output tokens per bucket, stacked (2 series, legend). Clicking a bucket narrows the range to it. */
export function TokenTrendChart({ points, bucket, onSelect }: { points: Array<{ bucket: string; inputTokens: number; outputTokens: number }>; bucket: 'hour' | 'day'; onSelect: (bucketIso: string) => void }) {
  const fmt = bucketLabel(bucket);
  return (
    <>
      <Legend items={[{ label: 'Input tokens', color: VIZ.series1 }, { label: 'Output tokens', color: VIZ.series2 }]} />
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(s) => s?.activeLabel && onSelect(String(s.activeLabel))} style={{ cursor: 'pointer' }}>
          <CartesianGrid vertical={false} stroke={VIZ.grid} />
          <XAxis dataKey="bucket" tickFormatter={fmt} stroke={VIZ.axis} tick={AXIS_TICK} tickLine={false} minTickGap={24} />
          <YAxis tickFormatter={compact} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<Tip title={fmt} format={full} />} cursor={{ fill: VIZ.hover }} />
          <Bar isAnimationActive={false} dataKey="inputTokens" name="Input" stackId="t" fill={VIZ.series1} stroke={VIZ.surface} strokeWidth={2} maxBarSize={28} />
          <Bar isAnimationActive={false} dataKey="outputTokens" name="Output" stackId="t" fill={VIZ.series2} stroke={VIZ.surface} strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

/** One series over time - a 2px line with a crosshair tooltip. */
export function LineTrendChart({ points, dataKey, name, bucket, format, onSelect }: { points: Array<Record<string, number | string>>; dataKey: string; name: string; bucket: 'hour' | 'day'; format: (n: number) => string; onSelect: (bucketIso: string) => void }) {
  const fmt = bucketLabel(bucket);
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(s) => s?.activeLabel && onSelect(String(s.activeLabel))} style={{ cursor: 'pointer' }}>
        <CartesianGrid vertical={false} stroke={VIZ.grid} />
        <XAxis dataKey="bucket" tickFormatter={fmt} stroke={VIZ.axis} tick={AXIS_TICK} tickLine={false} minTickGap={24} />
        <YAxis tickFormatter={(n: number) => format(n)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} />
        <Tooltip content={<Tip title={fmt} format={format} />} cursor={{ stroke: VIZ.axis, strokeWidth: 1 }} />
        <Line type="linear" dataKey={dataKey} name={name} stroke={VIZ.series1} strokeWidth={2} dot={points.length <= 2 ? { r: 4, fill: VIZ.series1, stroke: VIZ.surface, strokeWidth: 2 } : false} activeDot={{ r: 5, fill: VIZ.series1, stroke: VIZ.surface, strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Ranked single-series horizontal bars (one color - identity is the axis label). Clicking a bar filters to it. */
export function RankedBars({ rows, name, format, onSelect }: { rows: Array<{ key: string; label: string; value: number }>; name: string; format: (n: number) => string; onSelect: (key: string) => void }) {
  const data = rows.slice(0, 8);
  return (
    <ResponsiveContainer width="100%" height={Math.max(80, data.length * 34 + 24)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} onClick={(s) => s?.activePayload?.[0] && onSelect((s.activePayload[0].payload as { key: string }).key)} style={{ cursor: 'pointer' }}>
        <CartesianGrid horizontal={false} stroke={VIZ.grid} />
        <XAxis type="number" tickFormatter={(n: number) => format(n)} tick={AXIS_TICK} stroke={VIZ.axis} tickLine={false} />
        <YAxis type="category" dataKey="label" tick={{ ...AXIS_TICK, fill: VIZ.ink2 }} axisLine={false} tickLine={false} width={150} />
        <Tooltip content={<Tip title={(l) => l} format={format} />} cursor={{ fill: VIZ.hover }} />
        <Bar isAnimationActive={false} dataKey="value" name={name} fill={VIZ.series1} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
