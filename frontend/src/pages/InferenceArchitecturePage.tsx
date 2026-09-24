import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { Eligibility } from '../api/aiFactory';
import {
  CreateInferenceArchitectureInput,
  InferenceArchitecture,
  InferenceArchitectureDefaults,
  InferenceArchitectureResult,
  InferencePattern,
  PATTERNS,
} from '../api/inferenceArchitecture';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const ELIGIBILITY: Record<Eligibility, { label: string; color: string }> = {
  eligible: { label: 'Eligible', color: '#1e8449' },
  conditional: { label: 'Conditional', color: '#9a6700' },
  not_eligible: { label: 'Not eligible', color: '#b03a2e' },
  not_assessed: { label: 'Not assessed', color: '#7a7f8c' },
};

export function InferenceArchitecturePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<InferenceArchitectureDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<InferenceArchitecture | null>(null);
  const [form, setForm] = useState<CreateInferenceArchitectureInput>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<InferenceArchitectureDefaults>(`/projects/${id}/ai-factory/inference-architecture/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the design inputs.')));
    apiClient
      .get<InferenceArchitecture>(`/projects/${id}/ai-factory/inference-architecture/latest`)
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
      const { data } = await apiClient.post<InferenceArchitecture>(`/projects/${id}/ai-factory/inference-architecture`, form);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not design the inference architecture.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const patterns = form.patterns ?? defaults?.context.patterns ?? [];
  const togglePattern = (p: InferencePattern) => {
    const next = patterns.includes(p) ? patterns.filter((x) => x !== p) : [...patterns, p];
    setForm((f) => ({ ...f, patterns: next }));
  };
  const boolField = (k: 'hasKubernetes' | 'hasGpu', label: string) => {
    const d = defaults?.context[k];
    const s = defaults?.sources[k];
    return (
      <div className="field" key={k}>
        <label>{label}</label>
        <select value={form[k] === undefined ? '' : String(form[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value === '' ? undefined : e.target.value === 'true' }))}>
          <option value="">{d === null || d === undefined ? 'Default: not stated' : `Default: ${d ? 'Yes' : 'No'} - ${s?.detail ?? ''}`}</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </div>
    );
  };

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Inference Architecture" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Designs the Inference-as-a-Service layer around the <Link to={`/projects/${project.id}/inference`}>Inference assessment</Link>'s sizing: which serving
              technology (eligibility first, then score), which inference patterns, and the gateway, policy engine, model router, runtime and compute - with routing from{' '}
              <Link to={`/projects/${project.id}/model-selection`}>Model Selection</Link>. Latency percentiles are estimates until load-tested.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: '#9a6700' }}>{defaultsError}</div>}
            {defaults && (
              <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
                <section className="discovery-section">
                  <div className="discovery-section-header">
                    <span className="discovery-section-index">1</span>
                    <h2 className="discovery-section-title">Inference patterns and platform</h2>
                  </div>
                  <p className="discovery-section-sub">
                    Patterns default from the workload ({defaults.sources.patterns?.detail}). A serving option that cannot handle a required pattern is not eligible.
                  </p>
                  <div className="checkbox-grid">
                    {PATTERNS.map(([p, label]) => (
                      <label key={p} className={`checkbox-chip${patterns.includes(p) ? ' checked' : ''}`}>
                        <input type="checkbox" checked={patterns.includes(p)} onChange={() => togglePattern(p)} />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className="field-grid" style={{ marginTop: 12 }}>
                    {boolField('hasKubernetes', 'Kubernetes platform available')}
                    {boolField('hasGpu', 'GPUs available')}
                  </div>
                </section>
                {error && <div className="error-text">{error}</div>}
                <div>
                  <button className="primary-btn" type="submit" disabled={saving || patterns.length === 0}>
                    {saving ? 'Designing...' : latest ? 'Re-design (new version)' : 'Design inference architecture'}
                  </button>
                </div>
              </form>
            )}
            {latest && <ArchitectureResult r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function ArchitectureResult({ r, version, createdAt }: { r: InferenceArchitectureResult; version: number; createdAt: string }) {
  const a = r.architecture;
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${r.recommended ? '#2f6fde' : '#b03a2e'}` }}>
        <div className="metric-label">
          Inference Architecture Decision Record · v{version} · {new Date(createdAt).toLocaleString()} · confidence {r.confidence}
        </div>
        <div className="metric-value" style={{ fontSize: 20 }}>{r.recommended?.label ?? 'No serving option is feasible'}</div>
        {r.recommended && <div style={{ fontSize: 12, color: ELIGIBILITY[r.recommended.eligibility].color }}>{ELIGIBILITY[r.recommended.eligibility].label} · score {r.recommended.score.toFixed(3)}</div>}
        <Bullets items={r.why} />
      </div>

      {a && (
        <div className="card">
          <div className="metric-label" style={{ marginBottom: 10 }}>Target architecture (spec §8)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 6 }}>
            {a.layers.map((l, i) => (
              <div key={l.layer} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ border: '1px solid #c9d3e0', borderRadius: 8, padding: '8px 10px', background: '#f7f9fc', minWidth: 130, maxWidth: 200 }}>
                  <div style={{ fontSize: 11, color: '#5a6472', textTransform: 'uppercase' }}>{l.layer}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{l.component}</div>
                  <div style={{ fontSize: 11, color: '#5a6472' }}>{l.detail}</div>
                </div>
                {i < a.layers.length - 1 && <span style={{ color: '#7a7f8c' }}>→</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {a && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Latency - estimated percentiles (not measured; confirm with a load test)</div>
          {a.sla.latency.length ? (
            <Table
              headers={['Metric', 'P50', 'P95', 'P99', 'Target', 'P95 vs target']}
              rows={a.sla.latency.map((l) => [
                l.metric,
                `${l.p50.toLocaleString()} ms`,
                `${l.p95.toLocaleString()} ms`,
                `${l.p99.toLocaleString()} ms`,
                l.targetMs === null ? '—' : `${l.targetMs.toLocaleString()} ms`,
                l.meetsTargetAtP95 === null ? '—' : <strong key="m" style={{ color: l.meetsTargetAtP95 ? '#1e8449' : '#b03a2e' }}>{l.meetsTargetAtP95 ? 'Within target' : 'Exceeds target'}</strong>,
              ])}
            />
          ) : (
            <p style={{ fontSize: 13, color: '#5a6472' }}>Provider-managed serving - use the provider's published latency and your own measurements.</p>
          )}
          <Bullets items={a.sla.targets} />
        </div>
      )}

      {a && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Model routing (policy first, then default, cost and availability rules)</div>
          <Table headers={['When', 'Route to', 'Why']} rows={a.routes.map((x) => [x.when, x.routeTo, x.why])} />
        </div>
      )}

      {a && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
          <Panel title="Inference API" items={a.inferenceApi} />
          <Panel title="Inference gateway" items={a.gateway} />
          <Panel title="Policy engine" items={a.policy} />
          <Panel title="Runtime" items={a.runtime} />
          <Panel title="Compute" items={a.compute} />
          <Panel title="Replica strategy" items={a.replicaStrategy} />
          <Panel title="Autoscaling" items={a.autoscaling} />
          <Panel title="Load balancing" items={a.loadBalancing} />
          <Panel title="Fallback" items={a.fallback} />
          <Panel title="Observability" items={a.observability} />
          <Panel title="Security" items={a.security} />
          <div className="card">
            <div className="metric-label">Cost</div>
            <Table headers={['', 'Value', 'Evidence']} rows={a.cost.map((c) => [c.label, c.value, c.evidenceType.replace('_', '-')])} />
          </div>
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Serving options - eligibility is decided before scoring</div>
        <Table
          headers={['Option', 'Eligibility', 'Score', 'Why']}
          rows={r.candidates.map((c) => [
            c.label,
            <span key="e" style={{ color: ELIGIBILITY[c.eligibility].color, fontWeight: 600 }}>{ELIGIBILITY[c.eligibility].label}</span>,
            c.score.toFixed(3),
            [...c.failures, ...c.conditions, ...c.notes].join(' ') || '—',
          ])}
        />
      </div>

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
      <Bullets items={items} />
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
            {row.map((c, j) => (
              <td key={j} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
