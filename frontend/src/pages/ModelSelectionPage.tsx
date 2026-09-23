import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { Eligibility } from '../api/aiFactory';
import { CreateModelSelectionInput, EvaluatedModel, ModelSelection, ModelSelectionDefaults, ModelSelectionResult } from '../api/modelSelection';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const ELIGIBILITY: Record<Eligibility, { label: string; color: string }> = {
  eligible: { label: 'Eligible', color: '#1e8449' },
  conditional: { label: 'Conditional', color: '#9a6700' },
  not_eligible: { label: 'Not eligible', color: '#b03a2e' },
  not_assessed: { label: 'Not assessed', color: '#7a7f8c' },
};
const FAMILY = { open_weight: 'Open weights (self-hostable)', proprietary_api: 'Managed API tier' } as const;

type SelectKey = 'reasoningComplexity' | 'accuracyRequirement' | 'latencyPriority' | 'costPriority' | 'fineTuning';
type BoolKey = 'multilingual' | 'multimodal' | 'toolCalling' | 'structuredOutput' | 'codeGeneration' | 'selfHostingRequired' | 'permissiveLicenceOnly';

export function ModelSelectionPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<ModelSelectionDefaults | null>(null);
  const [latest, setLatest] = useState<ModelSelection | null>(null);
  const [form, setForm] = useState<CreateModelSelectionInput>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient.get<ModelSelectionDefaults>(`/projects/${id}/ai-factory/model-selection/defaults`).then((r) => setDefaults(r.data)).catch(() => setDefaults(null));
    apiClient
      .get<ModelSelection>(`/projects/${id}/ai-factory/model-selection/latest`)
      .then((r) => {
        setLatest(r.data);
        setForm(r.data.submitted);
      })
      .catch(() => setLatest(null));
  }, [id]);

  const set = <K extends keyof CreateModelSelectionInput>(k: K, v: CreateModelSelectionInput[K]) =>
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (v === undefined) delete next[k];
      return next;
    });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiClient.post<ModelSelection>(`/projects/${id}/ai-factory/model-selection`, form);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not run model selection.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;

  /** "Default: high - Workload Profile v1: agent workloads plan multi-step actions" */
  const defaultLabel = (k: string) => {
    const v = defaults?.requirements[k];
    const s = defaults?.sources[k];
    if (v === undefined || v === null || !s) return 'Default';
    const shown = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    return `Default: ${shown} - ${s.detail}`;
  };
  const select = (k: SelectKey, label: string, options: string[]) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <select value={(form[k] as string | undefined) ?? ''} onChange={(e) => set(k, (e.target.value || undefined) as never)}>
        <option value="">{defaultLabel(k)}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace('_', ' ')}
          </option>
        ))}
      </select>
    </div>
  );
  const bool = (k: BoolKey, label: string) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <select value={form[k] === undefined ? '' : String(form[k])} onChange={(e) => set(k, e.target.value === '' ? undefined : e.target.value === 'true')}>
        <option value="">{defaultLabel(k)}</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </div>
  );

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Model Selection" />
        {!features.aiFactory && !defaults ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Chooses a primary, secondary and fallback model from a technology-neutral catalogue: every candidate is first checked against mandatory requirements (a failure means{' '}
              <em>not eligible</em>, whatever it would score), then the rest are scored. Requirements left on <em>Default</em> are derived from the{' '}
              <Link to={`/projects/${project.id}/workload-profile`}>AI Workload Profile</Link>. Serving is sized separately in the{' '}
              <Link to={`/projects/${project.id}/inference`}>Inference assessment</Link>.
            </p>
            <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
              <Section n={1} title="Capabilities the model must have" sub="Mandatory - a model without them is not eligible.">
                <div className="field">
                  <label>Context needed (tokens)</label>
                  <input type="number" value={form.requiredContextTokens ?? ''} placeholder={defaultLabel('requiredContextTokens')} onChange={(e) => set('requiredContextTokens', e.target.value === '' ? undefined : Number(e.target.value))} />
                </div>
                {bool('toolCalling', 'Tool / function calling')}
                {bool('structuredOutput', 'Structured (JSON) output')}
                {bool('multimodal', 'Image / multimodal input')}
                {bool('multilingual', 'Multilingual')}
                {select('fineTuning', 'Fine-tuning', ['none', 'adapter', 'full'])}
              </Section>
              <Section n={2} title="Deployment, data and licence" sub="Constraints that can rule whole families out.">
                {bool('selfHostingRequired', 'Must run inside the customer boundary')}
                {bool('permissiveLicenceOnly', 'Permissive licences only')}
                <div className="field">
                  <label>Largest self-hostable model (B params)</label>
                  <input type="number" step={0.1} value={form.maxSelfHostedParamsB ?? ''} placeholder="No GPU limit stated" onChange={(e) => set('maxSelfHostedParamsB', e.target.value === '' ? undefined : Number(e.target.value))} />
                </div>
              </Section>
              <Section n={3} title="Quality and priorities" sub="Below the required tier → conditional (must pass the customer evaluation). Priorities change the scoring weights.">
                {select('accuracyRequirement', 'Accuracy', ['standard', 'high', 'critical'])}
                {select('reasoningComplexity', 'Reasoning complexity', ['low', 'medium', 'high'])}
                {bool('codeGeneration', 'Code generation')}
                {select('latencyPriority', 'Latency priority', ['low', 'medium', 'high'])}
                {select('costPriority', 'Cost priority', ['low', 'medium', 'high'])}
              </Section>
              {error && <div className="error-text">{error}</div>}
              <div>
                <button className="primary-btn" type="submit" disabled={saving}>
                  {saving ? 'Selecting...' : latest ? 'Re-run selection (new version)' : 'Select models'}
                </button>
              </div>
            </form>
            {latest && <SelectionResult r={latest.result} version={latest.version} createdAt={latest.createdAt} projectId={project.id} />}
          </>
        )}
      </div>
    </div>
  );
}

function SelectionResult({ r, version, createdAt, projectId }: { r: ModelSelectionResult; version: number; createdAt: string; projectId: string }) {
  return (
    <div style={{ marginTop: 28, maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${r.primary ? '#2f6fde' : '#b03a2e'}` }}>
        <div className="metric-label">
          Model Decision Record · v{version} · {new Date(createdAt).toLocaleString()} · confidence {r.confidence}
        </div>
        <div className="card-grid" style={{ marginTop: 10 }}>
          <Pick title="Primary" m={r.primary} />
          <Pick title="Secondary" m={r.secondary} sub={r.roles.secondary} />
          <Pick title="Fallback" m={r.fallback} sub={r.roles.fallback} />
        </div>
        <Bullets title="Why" items={r.why} />
        {r.primary && (
          <p style={{ fontSize: 13, margin: '10px 0 0' }}>
            <Link to={`/projects/${projectId}/inference`}>Size serving for this model in the Inference assessment →</Link> (it pre-fills from this selection; the serving design stays a separate decision)
          </p>
        )}
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">All candidates - eligibility is decided before scoring; a not-eligible model can never rank above an eligible one</div>
        <Table
          headers={['Model', 'Family', 'Eligibility', 'Score', 'Why']}
          rows={r.candidates.map((c) => [
            c.label,
            FAMILY[c.family],
            <span key="e" style={{ color: ELIGIBILITY[c.eligibility].color, fontWeight: 600 }}>{ELIGIBILITY[c.eligibility].label}</span>,
            c.score.toFixed(3),
            [...c.failures, ...c.conditions, ...c.notes].join(' ') || '—',
          ])}
        />
      </div>

      <div className="card-grid">
        <div className="card">
          <Bullets title="Trade-offs" items={r.tradeoffs} />
          <Bullets title="What would change this" items={r.wouldChangeIf} />
        </div>
        <div className="card">
          <Bullets title="Benchmark before production" items={r.benchmarkRequired} />
          <p style={{ fontSize: 12, color: '#5a6472', margin: '8px 0 0' }}>
            Scoring weights used: {Object.entries(r.weightsUsed).map(([k, v]) => `${k} ${v}`).join(', ')}. Tiers are relative planning ratings (config/models.yaml, rules {r.rulesVersion}), not benchmark results.
          </p>
        </div>
      </div>
    </div>
  );
}

function Pick({ title, m, sub }: { title: string; m: EvaluatedModel | null; sub?: string | null }) {
  return (
    <div className="card">
      <div className="metric-label">{title}</div>
      <div className="metric-value" style={{ fontSize: 18 }}>{m ? m.label : '—'}</div>
      {m && (
        <div style={{ fontSize: 12, color: '#5a6472', marginTop: 4 }}>
          {FAMILY[m.family]} · score {m.score.toFixed(3)} · <span style={{ color: ELIGIBILITY[m.eligibility].color }}>{ELIGIBILITY[m.eligibility].label}</span>
          {sub ? <div>{sub}</div> : null}
        </div>
      )}
    </div>
  );
}

function Section({ n, title, sub, children }: { n: number; title: string; sub: string; children: ReactNode }) {
  return (
    <section className="discovery-section">
      <div className="discovery-section-header">
        <span className="discovery-section-index">{n}</span>
        <h2 className="discovery-section-title">{title}</h2>
      </div>
      <p className="discovery-section-sub">{sub}</p>
      <div className="field-grid">{children}</div>
    </section>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#5a6472' }}>{title}</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
          {headers.map((h) => (
            <th key={h} style={{ padding: '6px 8px' }}>
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
