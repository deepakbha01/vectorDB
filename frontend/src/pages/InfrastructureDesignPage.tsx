import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { Eligibility } from '../api/aiFactory';
import { CreateInfrastructureDesignInput, InfrastructureDefaults, InfrastructureDesign, InfrastructureResult } from '../api/infrastructure';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const ELIGIBILITY: Record<Eligibility, { label: string; color: string }> = {
  eligible: { label: 'Eligible', color: '#1e8449' },
  conditional: { label: 'Conditional', color: '#9a6700' },
  not_eligible: { label: 'Not eligible', color: '#b03a2e' },
  not_assessed: { label: 'Not assessed', color: '#7a7f8c' },
};

const MODEL_COLOR = { single_target: '#2f6fde', hybrid: '#7d3cbd', not_feasible: '#b03a2e' } as const;

const SECTIONS: Array<[keyof InfrastructureResult['sections'], string]> = [
  ['compute', 'Compute'],
  ['memory', 'Memory'],
  ['storage', 'Storage'],
  ['network', 'Network'],
  ['cluster', 'Cluster'],
  ['availability', 'Availability'],
  ['disasterRecovery', 'Disaster recovery'],
  ['scaling', 'Scaling'],
  ['security', 'Security'],
];

export function InfrastructureDesignPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<InfrastructureDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<InfrastructureDesign | null>(null);
  const [form, setForm] = useState<CreateInfrastructureDesignInput>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<InfrastructureDefaults>(`/projects/${id}/ai-factory/infrastructure/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the design inputs.')));
    apiClient
      .get<InfrastructureDesign>(`/projects/${id}/ai-factory/infrastructure/latest`)
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
      const { data } = await apiClient.post<InfrastructureDesign>(`/projects/${id}/ai-factory/infrastructure`, form);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not design the infrastructure.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const boolField = (k: keyof CreateInfrastructureDesignInput, label: string) => {
    const d = defaults?.context[k];
    const s = defaults?.sources[k];
    return (
      <div className="field" key={k}>
        <label>{label}</label>
        <select value={form[k] === undefined ? '' : String(form[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value === '' ? undefined : e.target.value === 'true' }))}>
          <option value="">{d === null || d === undefined ? 'Default: not stated' : `Default: ${d ? 'Yes' : 'No'}${s ? ` - ${s.detail}` : ''}`}</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </div>
    );
  };
  const c = defaults?.context;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Infrastructure Design" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Places each component - inference serving from the <Link to={`/projects/${project.id}/inference-architecture`}>Inference Architecture</Link>, the vector
              database from <Link to={`/projects/${project.id}/vector-db-selection`}>Vector DB Selection</Link>, and the application tier - on an allowed target. Each placement is
              checked for eligibility before it is scored, and components are kept together where possible. The existing{' '}
              <Link to={`/projects/${project.id}/deployment`}>Deployment</Link> plan is unchanged.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: '#9a6700' }}>{defaultsError}</div>}
            {defaults && c && (
              <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
                <section className="discovery-section">
                  <div className="discovery-section-header">
                    <span className="discovery-section-index">1</span>
                    <h2 className="discovery-section-title">Platform facts</h2>
                  </div>
                  <p className="discovery-section-sub">
                    Everything else comes from earlier phases: allowed targets <strong>{c.allowedTargets.join(', ') || 'none'}</strong>
                    {c.restrictedData ? ', restricted data' : ''}
                    {c.dataResidency ? `, residency ${c.dataResidency}` : ''}, availability {c.availabilityTargetPercent}%, RPO {c.rpoMinutes ?? '—'} min, RTO{' '}
                    {c.rtoMinutes ?? '—'} min, operations: {c.opsCapability.replace(/_/g, ' ')}.
                  </p>
                  <div className="field-grid">
                    {boolField('hasKubernetes', 'On-premises Kubernetes available')}
                    {boolField('hasGpu', 'On-premises GPUs available')}
                    {boolField('multipleOnPremSites', 'More than one on-premises site')}
                  </div>
                  <div style={{ marginTop: 12, fontSize: 13 }}>
                    <strong>Components to place:</strong>
                    <Bullets items={c.components.map((x) => `${x.label}: ${x.platforms.join(' / ')}${x.gpuLabel ? ` · ${x.gpuLabel}` : ''}${x.detail ? ` - ${x.detail}` : ''}`)} />
                  </div>
                </section>
                {error && <div className="error-text">{error}</div>}
                <div>
                  <button className="primary-btn" type="submit" disabled={saving}>
                    {saving ? 'Designing...' : latest ? 'Re-design (new version)' : 'Design infrastructure'}
                  </button>
                </div>
              </form>
            )}
            {latest && <InfrastructureResultView r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function InfrastructureResultView({ r, version, createdAt }: { r: InfrastructureResult; version: number; createdAt: string }) {
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${MODEL_COLOR[r.deploymentModel.kind]}` }}>
        <div className="metric-label">
          Infrastructure Decision Record · v{version} · {new Date(createdAt).toLocaleString()} · confidence {r.confidence}
        </div>
        <div className="metric-value" style={{ fontSize: 20 }}>{r.deploymentModel.summary}</div>
        <div style={{ fontSize: 12, color: '#5a6472' }}>{r.deploymentModel.kind.replace('_', ' ')}</div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Placements</div>
        <Table
          headers={['Component', 'Placed on', 'Eligibility', 'Why', 'Conditions']}
          rows={r.placements.map((p) => [
            p.componentLabel,
            p.chosen?.label ?? <strong key="n" style={{ color: '#b03a2e' }}>Not feasible</strong>,
            p.chosen ? <span key="e" style={{ color: ELIGIBILITY[p.chosen.eligibility].color, fontWeight: 600 }}>{ELIGIBILITY[p.chosen.eligibility].label}</span> : '—',
            p.why,
            p.chosen ? [...p.chosen.conditions, ...p.chosen.notes].join(' ') || '—' : '—',
          ])}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {SECTIONS.map(([k, title]) => (
          <Panel key={k} title={title} items={r.sections[k]} />
        ))}
        <div className="card">
          <div className="metric-label">Sizing</div>
          <Table headers={['', 'Value', 'Evidence']} rows={r.sizing.map((s) => [s.label, s.value, s.evidenceType.replace('_', '-')])} />
        </div>
      </div>

      {r.placements.map((p) => (
        <div key={p.component} className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">{p.componentLabel} - candidate placements (eligibility is decided before scoring)</div>
          <Table
            headers={['Placement', 'Eligibility', 'Score', 'Why']}
            rows={p.candidates.map((x) => [
              x.label,
              <span key="e" style={{ color: ELIGIBILITY[x.eligibility].color, fontWeight: 600 }}>{ELIGIBILITY[x.eligibility].label}</span>,
              x.score.toFixed(3),
              [...x.failures, ...x.conditions, ...x.notes].join(' ') || '—',
            ])}
          />
        </div>
      ))}

      <div className="card-grid">
        <Panel title="Benchmark before production" items={r.benchmarkRequired} />
        <Panel title="What would change this" items={r.wouldChangeIf} />
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
