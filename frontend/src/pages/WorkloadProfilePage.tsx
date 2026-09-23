import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { EvidenceType } from '../api/aiFactory';
import {
  CreateWorkloadProfileInput,
  DATA_TYPES,
  DEPLOYMENT_TARGETS,
  ResolvedValue,
  WORKLOAD_TYPES,
  WorkloadProfile,
  WorkloadProfileDefaults,
  WorkloadProfileResult,
} from '../api/workloadProfile';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const EMPTY: CreateWorkloadProfileInput = { businessObjective: '', businessCriticality: 'medium', workloadTypes: [], dataTypes: [], deploymentTargets: [] };
const TIER_LABEL: Record<string, string> = { small: 'Small', medium: 'Medium', large: 'Large', enterprise: 'Enterprise', extreme_scale: 'Extreme Scale' };
const LEVEL_COLOR: Record<string, string> = { restricted: '#b03a2e', confidential: '#9a6700', internal: '#1e8449' };
const EVIDENCE: Record<EvidenceType, { label: string; color: string }> = {
  measured: { label: 'Measured', color: '#1e8449' },
  estimated: { label: 'Estimated', color: '#2f6fde' },
  vendor_listed: { label: 'Vendor-listed', color: '#6b3fa0' },
  assumption: { label: 'Assumption', color: '#9a6700' },
};

type NumKey = 'expectedUsers' | 'numberOfApplications' | 'documentCount' | 'expectedVectorCount' | 'dailyRequests' | 'peakQps' | 'concurrentUsers' | 'dataGrowthPercentPerMonth' | 'targetLatencyMs' | 'targetTtftMs' | 'throughputRps' | 'availabilityTargetPercent';
type BoolKey = 'containsPii' | 'containsPhi' | 'containsPci' | 'confidentialData';

/** "Discovery v4: 5,000,000" - what a blank answer will default to. */
function fallbackText(v?: ResolvedValue): string | undefined {
  if (!v || v.source === 'missing' || v.source === 'profile' || v.value === null) return undefined;
  const value = typeof v.value === 'number' ? v.value.toLocaleString() : Array.isArray(v.value) ? v.value.join(', ') : String(v.value);
  return `${v.detail ?? v.source}: ${value}`;
}

export function WorkloadProfilePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<WorkloadProfileDefaults | null>(null);
  const [latest, setLatest] = useState<WorkloadProfile | null>(null);
  const [form, setForm] = useState<CreateWorkloadProfileInput>(EMPTY);
  const [sources, setSources] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient.get<WorkloadProfileDefaults>(`/projects/${id}/ai-factory/workload-profile/defaults`).then((r) => setDefaults(r.data)).catch(() => setDefaults(null));
    apiClient
      .get<WorkloadProfile>(`/projects/${id}/ai-factory/workload-profile/latest`)
      .then((r) => {
        setLatest(r.data);
        setForm({ ...EMPTY, ...r.data.submitted });
        setSources((r.data.submitted.dataSources ?? []).join(', '));
      })
      .catch(() => setLatest(null));
  }, [id]);

  const set = <K extends keyof CreateWorkloadProfileInput>(k: K, v: CreateWorkloadProfileInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = <T extends string>(k: 'workloadTypes' | 'dataTypes' | 'deploymentTargets', value: T) =>
    setForm((f) => {
      const cur = (f[k] ?? []) as string[];
      return { ...f, [k]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] };
    });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSaving(true);
    setError(null);
    const payload: CreateWorkloadProfileInput = {
      ...form,
      dataSources: sources.split(',').map((s) => s.trim()).filter(Boolean),
    };
    // Blank optional answers are omitted so the server falls back to Discovery / the project and records that it did.
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined && v !== '')) as CreateWorkloadProfileInput;
    try {
      const { data } = await apiClient.post<WorkloadProfile>(`/projects/${id}/ai-factory/workload-profile`, clean);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save the workload profile.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const inputs = defaults?.inputs ?? {};

  const num = (k: NumKey, label: string, step?: number) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <input type="number" step={step ?? 1} value={form[k] ?? ''} placeholder={fallbackText(inputs[k])} onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))} />
    </div>
  );
  const bool = (k: BoolKey, label: string) => {
    const fb = inputs[k];
    return (
      <div className="field" key={k}>
        <label>{label}</label>
        <select value={form[k] === undefined ? '' : String(form[k])} onChange={(e) => set(k, e.target.value === '' ? undefined : e.target.value === 'true')}>
          <option value="">{fb && fb.source !== 'missing' ? `Use ${fb.detail ?? fb.source} (${fb.value ? 'Yes' : 'No'})` : 'Not specified'}</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </div>
    );
  };
  const chips = <T extends string>(k: 'workloadTypes' | 'dataTypes' | 'deploymentTargets', options: Array<[T, string]>) => (
    <div className="checkbox-grid" style={{ gridColumn: '1 / -1' }}>
      {options.map(([value, label]) => {
        const checked = ((form[k] ?? []) as string[]).includes(value);
        return (
          <label key={value} className={`checkbox-chip${checked ? ' checked' : ''}`}>
            <input type="checkbox" checked={checked} onChange={() => toggle(k, value)} />
            {label}
          </label>
        );
      })}
    </div>
  );

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="AI Workload Profile" />
        {!features.aiFactory && !defaults ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Describes the AI workload itself - business goal, workload type, data, scale, deployment and sensitivity - and classifies it. Blank answers are taken from{' '}
              <Link to={`/projects/${project.id}/discovery`}>Discovery</Link> or the project details and labelled as such, so nothing is asked twice. Part of step 01-02 in the{' '}
              <Link to={`/projects/${project.id}/ai-factory`}>AI Factory</Link> view.
            </p>
            <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
              <Section n={1} title="Business" sub="What the organisation wants from this AI system.">
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Business objective *</label>
                  <textarea rows={2} maxLength={500} value={form.businessObjective} placeholder={fallbackText(inputs.businessObjective)} onChange={(e) => set('businessObjective', e.target.value)} style={{ width: '100%', padding: 8 }} />
                </div>
                <div className="field">
                  <label>Business domain</label>
                  <input value={form.businessDomain ?? ''} maxLength={120} placeholder={fallbackText(inputs.businessDomain)} onChange={(e) => set('businessDomain', e.target.value || undefined)} />
                </div>
                <div className="field">
                  <label>Business criticality *</label>
                  <select value={form.businessCriticality} onChange={(e) => set('businessCriticality', e.target.value as CreateWorkloadProfileInput['businessCriticality'])}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="mission_critical">Mission critical</option>
                  </select>
                </div>
                {num('expectedUsers', 'Expected users')}
                {num('numberOfApplications', 'Applications served')}
                <div className="field" style={{ gridColumn: 'span 2' }}>
                  <label>Business SLA</label>
                  <input value={form.businessSla ?? ''} maxLength={200} placeholder='e.g. "answers within 3 s during business hours"' onChange={(e) => set('businessSla', e.target.value || undefined)} />
                </div>
              </Section>

              <Section n={2} title="AI workload & data" sub="Drives the architecture class and whether the workload is multimodal.">
                <div style={{ gridColumn: '1 / -1', fontSize: 12, fontWeight: 600 }}>Workload types *</div>
                {chips('workloadTypes', WORKLOAD_TYPES)}
                <div style={{ gridColumn: '1 / -1', fontSize: 12, fontWeight: 600 }}>Data types</div>
                {chips('dataTypes', DATA_TYPES)}
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Data sources (comma-separated)</label>
                  <input value={sources} placeholder="e.g. SharePoint, Confluence, Salesforce" onChange={(e) => setSources(e.target.value)} />
                </div>
              </Section>

              <Section n={3} title="Scale" sub="Blank → taken from Discovery (placeholder shows the value that will be used).">
                {num('documentCount', 'Documents')}
                {num('expectedVectorCount', 'Expected vectors')}
                {num('dailyRequests', 'Daily AI requests')}
                {num('peakQps', 'Peak QPS', 0.1)}
                {num('concurrentUsers', 'Concurrent users')}
                {num('dataGrowthPercentPerMonth', 'Data growth (% / month)', 0.1)}
              </Section>

              <Section n={4} title="Performance" sub="End-to-end targets for the AI response, not just the vector query.">
                {num('targetLatencyMs', 'End-to-end latency (ms)')}
                {num('targetTtftMs', 'Time to first token (ms)')}
                {num('throughputRps', 'Throughput (req/s)', 0.1)}
                {num('availabilityTargetPercent', 'Availability (%)', 0.01)}
              </Section>

              <Section n={5} title="Deployment & compliance" sub="Named targets - selecting more than one makes the architecture hybrid. No target is preferred.">
                <div style={{ gridColumn: '1 / -1', fontSize: 12, fontWeight: 600 }}>Allowed deployment targets *</div>
                {chips('deploymentTargets', DEPLOYMENT_TARGETS)}
                {bool('containsPii', 'Personal data (PII)')}
                {bool('containsPhi', 'Health data (PHI)')}
                {bool('containsPci', 'Payment card data (PCI)')}
                {bool('confidentialData', 'Confidential business data')}
                <div className="field">
                  <label>Data residency</label>
                  <input value={form.dataResidencyRequirement ?? ''} maxLength={200} placeholder={fallbackText(inputs.dataResidencyRequirement)} onChange={(e) => set('dataResidencyRequirement', e.target.value || undefined)} />
                </div>
                <div className="field">
                  <label>Regulatory requirements</label>
                  <input value={form.regulatoryRequirements ?? ''} maxLength={300} placeholder={fallbackText(inputs.regulatoryRequirements)} onChange={(e) => set('regulatoryRequirements', e.target.value || undefined)} />
                </div>
              </Section>

              {error && <div className="error-text">{error}</div>}
              <div>
                <button className="primary-btn" type="submit" disabled={saving}>
                  {saving ? 'Classifying...' : latest ? 'Save new version' : 'Create workload profile'}
                </button>
              </div>
            </form>

            {latest && <ProfileResult result={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function ProfileResult({ result: r, version, createdAt }: { result: WorkloadProfileResult; version: number; createdAt: string }) {
  return (
    <div style={{ marginTop: 28, maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${r.status === 'complete' ? '#2f6fde' : '#9a6700'}` }}>
        <div className="metric-label">
          AI Workload Profile · v{version} · {new Date(createdAt).toLocaleString()} · {r.status === 'complete' ? 'complete' : 'incomplete'}
        </div>
        {r.missingInputs.length > 0 && (
          <p style={{ fontSize: 13, color: '#9a6700', margin: '6px 0 0' }}>Still needed before downstream phases rely on it: {r.missingInputs.join(', ')}.</p>
        )}
        <div className="card-grid" style={{ marginTop: 12 }}>
          <Metric label="Workload size" value={r.workloadSize.tier ? TIER_LABEL[r.workloadSize.tier] : '—'} sub={r.workloadSize.explanation} />
          <Metric label="Architecture" value={r.architecture.label ?? '—'} sub={r.architecture.explanation} />
          <Metric label="Data classification" value={r.dataClassification.level} color={LEVEL_COLOR[r.dataClassification.level]} sub={r.dataClassification.reasons.join(' ')} />
          <Metric
            label="Deployment"
            value={r.deploymentRequirements.targets.length ? r.deploymentRequirements.targets.map((t) => DEPLOYMENT_TARGETS.find(([k]) => k === t)?.[1] ?? t).join(' + ') : '—'}
            sub={r.deploymentRequirements.hybrid ? 'Hybrid' : undefined}
          />
        </div>
      </div>

      {r.workloadSize.drivers.length > 0 && (
        <div className="card">
          <div className="metric-label">How the size was classified (highest dimension wins)</div>
          <Table headers={['Dimension', 'Value', 'Tier']} rows={r.workloadSize.drivers.map((d) => [d.label, d.value.toLocaleString(), TIER_LABEL[d.tier]])} />
        </div>
      )}

      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Scale profile</div>
          <Table headers={['', 'Value', 'Evidence']} rows={r.scaleProfile.map((x) => [x.label, x.value, <Evidence key="e" t={x.evidenceType} />])} />
        </div>
        <div className="card">
          <div className="metric-label">Performance profile</div>
          {r.performanceProfile.length ? (
            <Table headers={['', 'Value', 'Evidence']} rows={r.performanceProfile.map((x) => [x.label, x.value, <Evidence key="e" t={x.evidenceType} />])} />
          ) : (
            <p style={{ fontSize: 13, color: '#5a6472' }}>No performance targets given yet.</p>
          )}
        </div>
      </div>

      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Security requirements ({r.dataClassification.level})</div>
          <Bullets items={r.securityRequirements.controls} />
          {r.securityRequirements.alreadyRequired.length > 0 && <p style={{ fontSize: 12, color: '#5a6472' }}>Already required in Discovery: {r.securityRequirements.alreadyRequired.join(', ')}.</p>}
          <Bullets items={r.securityRequirements.notes} color="#9a6700" />
        </div>
        <div className="card">
          <div className="metric-label">Deployment requirements</div>
          <Bullets items={r.deploymentRequirements.notes.length ? r.deploymentRequirements.notes : ['No deployment constraints beyond the selected targets.']} />
        </div>
      </div>

      {r.assumptions.length > 0 && (
        <div className="card">
          <div className="metric-label">Key assumptions - values not entered here, taken from elsewhere</div>
          <Table headers={['Assumption', 'Evidence']} rows={r.assumptions.map((a) => [a.statement, <Evidence key="e" t={a.evidenceType} />])} />
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

function Metric({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color, textTransform: 'capitalize' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#5a6472', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Evidence({ t }: { t: EvidenceType }) {
  return <span style={{ color: EVIDENCE[t].color, fontWeight: 600, fontSize: 12 }}>{EVIDENCE[t].label}</span>;
}

function Bullets({ items, color }: { items: string[]; color?: string }) {
  if (!items.length) return null;
  return (
    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color }}>
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
