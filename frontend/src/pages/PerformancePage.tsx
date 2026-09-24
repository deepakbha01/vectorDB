import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { Measurement, MetricResult, MetricStatus, PerformanceAssessment, PerformanceDefaults, PerformanceResult } from '../api/performance';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const STATUS: Record<MetricStatus, { label: string; color: string }> = {
  pass: { label: 'PASS', color: '#1e8449' },
  pass_with_conditions: { label: 'PASS WITH CONDITIONS', color: '#9a6700' },
  fail: { label: 'FAIL', color: '#b03a2e' },
  requires_benchmark: { label: 'REQUIRES BENCHMARK', color: '#7d3cbd' },
  not_applicable: { label: 'Not applicable', color: '#7a7f8c' },
};

const linkBtn = { background: 'none', border: 'none', padding: 0, color: '#2f6fde', cursor: 'pointer', fontSize: 13 } as const;
const withUnit = (v: number, unit: string) => `${v.toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit ? (unit === '%' ? '%' : ` ${unit}`) : ''}`;

type Row = { metric: string; value: string; source: string; measuredAt: string };
const toRows = (m: Measurement[] | undefined): Row[] => (m ?? []).map((x) => ({ metric: x.metric, value: String(x.value), source: x.source, measuredAt: x.measuredAt?.slice(0, 10) ?? '' }));

export function PerformancePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<PerformanceDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<PerformanceAssessment | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<PerformanceDefaults>(`/projects/${id}/ai-factory/performance/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the assessment inputs.')));
    apiClient
      .get<PerformanceAssessment>(`/projects/${id}/ai-factory/performance/latest`)
      .then((r) => {
        setLatest(r.data);
        setRows(toRows(r.data.submitted.measurements));
      })
      .catch(() => setLatest(null));
  }, [id]);

  const metrics: MetricResult[] = (latest?.result ?? defaults?.preview)?.groups.flatMap((g) => g.metrics).filter((m) => m.status !== 'not_applicable') ?? [];
  const unitOf = (metric: string) => metrics.find((m) => m.id === metric)?.unit ?? '';

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const measurements = rows.map((r) => ({ metric: r.metric, value: Number(r.value), source: r.source.trim(), ...(r.measuredAt ? { measuredAt: r.measuredAt } : {}) }));
      const { data } = await apiClient.post<PerformanceAssessment>(`/projects/${id}/ai-factory/performance`, { measurements });
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not run the performance assessment.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const incomplete = rows.some((r) => !r.metric || r.value === '' || Number.isNaN(Number(r.value)) || r.source.trim().length < 3);

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Performance & Benchmark" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Can the recommended architecture meet the workload's requirements? A metric passes or fails only on <strong>measured</strong> evidence - the{' '}
              <Link to={`/projects/${project.id}/optimization`}>vector benchmark</Link>, <Link to={`/projects/${project.id}/ingestion`}>ingestion runs</Link>, or results
              recorded below with their source. Without a measurement it REQUIRES BENCHMARK, whatever the estimate says; estimates are shown only as an early warning.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: '#9a6700' }}>{defaultsError}</div>}
            {defaults && (
              <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
                <section className="discovery-section">
                  <div className="discovery-section-header">
                    <span className="discovery-section-index">1</span>
                    <h2 className="discovery-section-title">Benchmark results measured outside the platform</h2>
                  </div>
                  <p className="discovery-section-sub">
                    Record LLM load tests, evaluation scores, GPU / CPU / RAM readings and similar. The source (tool, environment, load) is required - no evidence, no
                    measurement. Results older than the design they describe are flagged.
                  </p>
                  {rows.length > 0 && (
                    <Table
                      headers={['Metric', 'Value', 'Source (tool, environment, load)', 'Measured on', '']}
                      rows={rows.map((r, i) => [
                        <select key="m" value={r.metric} onChange={(e) => update(i, { metric: e.target.value })}>
                          <option value="">Choose...</option>
                          {metrics.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>,
                        <span key="v" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input type="number" step="any" value={r.value} onChange={(e) => update(i, { value: e.target.value })} style={{ width: 110 }} />
                          <span style={{ fontSize: 12, color: '#5a6472' }}>{unitOf(r.metric)}</span>
                        </span>,
                        <input key="s" value={r.source} onChange={(e) => update(i, { source: e.target.value })} placeholder="e.g. vLLM benchmark_serving, staging cluster, 40 concurrent" style={{ width: '100%' }} />,
                        <input key="d" type="date" value={r.measuredAt} onChange={(e) => update(i, { measuredAt: e.target.value })} />,
                        <button key="x" type="button" style={linkBtn} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                          Remove
                        </button>,
                      ])}
                    />
                  )}
                  <button type="button" style={{ ...linkBtn, marginTop: 10 }} onClick={() => setRows((rs) => [...rs, { metric: '', value: '', source: '', measuredAt: '' }])}>
                    + Record a measurement
                  </button>
                </section>
                {error && <div className="error-text">{error}</div>}
                <div>
                  <button className="primary-btn" type="submit" disabled={saving || incomplete}>
                    {saving ? 'Assessing...' : latest ? 'Re-assess (new version)' : 'Run performance assessment'}
                  </button>
                  {incomplete && <span style={{ fontSize: 12, color: '#9a6700', marginLeft: 10 }}>Every measurement needs a metric, a number and a source.</span>}
                </div>
              </form>
            )}
            {latest && <PerformanceResultView r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function PerformanceResultView({ r, version, createdAt }: { r: PerformanceResult; version: number; createdAt: string }) {
  const s = STATUS[r.status.status];
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${s.color}` }}>
        <div className="metric-label">
          Performance &amp; Benchmark Assessment · v{version} · {new Date(createdAt).toLocaleString()}
        </div>
        <div className="metric-value" style={{ fontSize: 20, color: s.color }}>{s.label}</div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {(['pass', 'pass_with_conditions', 'fail', 'requires_benchmark'] as const)
            .filter((k) => r.counts[k])
            .map((k) => `${r.counts[k]} ${STATUS[k].label.toLowerCase()}`)
            .join(' · ')}
        </div>
        <Bullets items={r.status.reasons} />
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #9a6700' }}>
          <div className="metric-label">Missing inputs</div>
          <Bullets items={r.gaps} />
        </div>
      )}

      {r.groups.map((g) => (
        <div key={g.id} className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">{g.label}</div>
          <Table
            headers={['Metric', 'Target', 'Estimate', 'Measured', 'Status', 'Why']}
            rows={g.metrics.map((m) => [
              m.label,
              m.target ? <Cell key="t" value={withUnit(m.target.value, m.unit)} note={`${m.target.assumed && !/^assumption/i.test(m.target.source) ? 'assumption - ' : ''}${m.target.source}`} /> : '—',
              m.estimate ? (
                <Cell key="e" value={withUnit(m.estimate.value, m.unit)} note={`${m.estimate.evidenceType.replace('_', '-')} - ${m.estimate.source}`} warn={m.estimateMeetsTarget === false} />
              ) : (
                '—'
              ),
              m.measured ? <Cell key="m" value={withUnit(m.measured.value, m.unit)} note={`measured${m.measured.measuredAt ? ` ${m.measured.measuredAt.slice(0, 10)}` : ''} - ${m.measured.source}`} /> : '—',
              <strong key="s" style={{ color: STATUS[m.status].color, whiteSpace: 'nowrap' }}>{STATUS[m.status].label}</strong>,
              [...m.reasons, ...m.conditions].join(' '),
            ])}
          />
        </div>
      ))}

      {r.benchmarkPlan.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Benchmark plan - what to measure next</div>
          <Table headers={['Metric', 'How to measure', '']} rows={r.benchmarkPlan.map((b) => [b.metric, b.how, b.warning ? <span key="w" style={{ color: '#b03a2e' }}>{b.warning}</span> : ''])} />
        </div>
      )}
    </div>
  );
}

function Cell({ value, note, warn }: { value: string; note: string; warn?: boolean }) {
  return (
    <span>
      <span style={{ fontWeight: 600, color: warn ? '#b03a2e' : undefined }}>{value}</span>
      <div style={{ fontSize: 11, color: '#7a7f8c' }}>{note}</div>
    </span>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
          {headers.map((h, i) => (
            <th key={i} style={{ padding: '6px 8px' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: '1px solid #eceff3' }}>
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
