import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { CreateOperationsModelInput, ON_CALL, OnCallCoverage, OperationsDefaults, OperationsModel, OperationsResult } from '../api/operations';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const VERDICT = {
  pass_with_conditions: { label: 'Operable with conditions', color: '#9a6700' },
  further_assessment: { label: 'Requires further assessment', color: '#7d3cbd' },
  fail: { label: 'Not operable as designed', color: '#b03a2e' },
} as const;
const AREA_STATUS = {
  from_design: { label: 'From the design', color: '#1e8449' },
  defined_here: { label: 'Defined here', color: '#2f6fde' },
  gap: { label: 'Gap', color: '#b03a2e' },
} as const;
const verdictMark = (ok: boolean | null) => (ok === null ? '—' : <strong style={{ color: ok ? '#1e8449' : '#b03a2e' }}>{ok ? 'Meets target' : 'Misses target'}</strong>);

export function OperationsModelPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<OperationsDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<OperationsModel | null>(null);
  const [form, setForm] = useState<CreateOperationsModelInput>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<OperationsDefaults>(`/projects/${id}/ai-factory/operations/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the operations inputs.')));
    apiClient
      .get<OperationsModel>(`/projects/${id}/ai-factory/operations/latest`)
      .then((r) => {
        setLatest(r.data);
        setForm(r.data.submitted);
      })
      .catch(() => setLatest(null));
  }, [id]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiClient.post<OperationsModel>(`/projects/${id}/ai-factory/operations`, form);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not build the operations model.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const c = defaults?.context;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Operations Model" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Can this run as a production AI platform? Brings together the operational parts of the <Link to={`/projects/${project.id}/inference-architecture`}>Inference Architecture</Link>,{' '}
              <Link to={`/projects/${project.id}/infrastructure-design`}>Infrastructure Design</Link> and <Link to={`/projects/${project.id}/capacity`}>Capacity plan</Link>, checks the SLA,
              RTO and RPO against estimated availability and recovery time, and checks whether the team can run what the design asks.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: '#9a6700' }}>{defaultsError}</div>}
            {defaults && c && (
              <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
                <section className="discovery-section">
                  <div className="discovery-section-header">
                    <span className="discovery-section-index">1</span>
                    <h2 className="discovery-section-title">Operating facts</h2>
                  </div>
                  <p className="discovery-section-sub">
                    From earlier phases: availability {c.availabilityTargetPercent}%, RPO {c.rpoMinutes ?? '—'} min, RTO {c.rtoMinutes ?? '—'} min, {c.dr.tier} DR ({c.dr.reason}), operations:{' '}
                    {c.opsCapability.replace(/_/g, ' ')}.
                  </p>
                  <div className="field-grid">
                    <div className="field">
                      <label>On-call coverage</label>
                      <select value={form.onCallCoverage ?? ''} onChange={(e) => setForm((f) => ({ ...f, onCallCoverage: e.target.value === '' ? undefined : (e.target.value as OnCallCoverage) }))}>
                        <option value="">Default: not stated</option>
                        {ON_CALL.map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>DR rehearsed end to end</label>
                      <select value={form.drTested === undefined ? '' : String(form.drTested)} onChange={(e) => setForm((f) => ({ ...f, drTested: e.target.value === '' ? undefined : e.target.value === 'true' }))}>
                        <option value="">Default: No - not stated</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    </div>
                  </div>
                </section>
                {error && <div className="error-text">{error}</div>}
                <div>
                  <button className="primary-btn" type="submit" disabled={saving}>
                    {saving ? 'Building...' : latest ? 'Re-build (new version)' : 'Build operations model'}
                  </button>
                </div>
              </form>
            )}
            {latest && <OperationsResultView r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function OperationsResultView({ r, version, createdAt }: { r: OperationsResult; version: number; createdAt: string }) {
  const v = VERDICT[r.verdict.status];
  const d = r.definitions;
  const load = r.operationalLoad;
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${v.color}` }}>
        <div className="metric-label">
          AI Operations Model · v{version} · {new Date(createdAt).toLocaleString()}
        </div>
        <div className="metric-value" style={{ fontSize: 20, color: v.color }}>{v.label}</div>
        <Bullets items={r.verdict.reasons} />
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #9a6700' }}>
          <div className="metric-label">Gaps to close</div>
          <Bullets items={r.gaps} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">SLA - serial availability of the request path (estimate)</div>
          <Table headers={['Component', 'Availability', 'Basis']} rows={d.sla.components.map((x) => [x.component, `${x.percent}%`, <span key="b" style={{ fontSize: 12, color: '#5a6472' }}>{x.basis}</span>])} />
          <p style={{ fontSize: 13, marginTop: 8 }}>
            Estimated <strong>{d.sla.estimatedPercent ?? '—'}%</strong> against a {d.sla.targetPercent}% target · {verdictMark(d.sla.meets)}
          </p>
        </div>
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">RTO - {d.rto.tier} DR recovery (estimate)</div>
          <Table headers={['Step', 'Minutes']} rows={d.rto.steps.map((s) => [s.step, s.minutes])} />
          <p style={{ fontSize: 13, marginTop: 8 }}>
            Estimated <strong>{d.rto.estimatedMinutes} min</strong>
            {d.rto.targetMinutes !== null ? ` against an RTO of ${d.rto.targetMinutes} min` : ' (no RTO stated)'} · {verdictMark(d.rto.meets)}
          </p>
          <div className="metric-label" style={{ marginTop: 12 }}>RPO{d.rpo.targetMinutes !== null ? ` - ${d.rpo.targetMinutes} min` : ''}</div>
          <Bullets items={[d.rpo.method, ...d.rpo.conditions]} />
        </div>
        <div className="card">
          <div className="metric-label">Can the team run it?</div>
          <Table headers={['What the design asks the team to run', 'Load']} rows={load.items.map((i) => [i.item, i.points])} />
          <p style={{ fontSize: 13, marginTop: 8, color: load.withinCapacity ? '#1e8449' : '#b03a2e' }}>
            Load {load.total} against {load.capacity} for a {load.opsCapability.replace(/_/g, ' ')} - {load.withinCapacity ? 'within capacity' : 'exceeds capacity'}.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        <Panel title="Scaling policy" items={d.scalingPolicy} />
        <Panel title="Failover strategy" items={d.failoverStrategy} />
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Capacity thresholds</div>
          <Table headers={['Metric', 'Threshold', 'Action']} rows={d.capacityThresholds.map((t) => [t.metric, t.threshold, t.action])} />
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Operations areas (spec §14)</div>
        <Table
          headers={['Area', 'Status', 'What is in place', 'Still to do']}
          rows={r.areas.map((a) => [
            a.label,
            <strong key="s" style={{ color: AREA_STATUS[a.status].color, whiteSpace: 'nowrap' }}>{AREA_STATUS[a.status].label}</strong>,
            a.items.length ? (
              <ul key="i" style={{ margin: 0, paddingLeft: 16 }}>
                {a.items.slice(0, 4).map((i, k) => (
                  <li key={k}>
                    {i.text} <span style={{ fontSize: 11, color: '#7a7f8c' }}>({i.source})</span>
                  </li>
                ))}
                {a.items.length > 4 && <li>+{a.items.length - 4} more</li>}
              </ul>
            ) : (
              '—'
            ),
            a.actions.join(' ') || '—',
          ])}
        />
      </div>

      <div className="card-grid">
        <Panel title="What would change this" items={r.wouldChangeIf} />
        <Panel title="Evidence" items={[r.evidenceNote]} />
      </div>
    </div>
  );
}

function Panel({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="card">
      <div className="metric-label">{title}</div>
      {items.length ? <Bullets items={items} /> : <div style={{ fontSize: 13, color: '#7a7f8c', marginTop: 6 }}>Nothing specific.</div>}
    </div>
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
