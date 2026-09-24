import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { ControlAssessment, CreateSecurityAssessmentInput, PolicyStatus, SecurityAssessment, SecurityDefaults, SecurityResult } from '../api/security';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const POLICY: Record<PolicyStatus, { label: string; color: string }> = {
  approved: { label: 'Approved', color: '#1e8449' },
  approved_with_conditions: { label: 'Approved with conditions', color: '#9a6700' },
  restricted: { label: 'Restricted', color: '#b35c00' },
  not_eligible: { label: 'Not eligible', color: '#b03a2e' },
};

const VALIDATION: Record<SecurityResult['validation']['status'], { label: string; color: string }> = {
  pass: { label: 'Pass', color: '#1e8449' },
  pass_with_conditions: { label: 'Pass with conditions', color: '#9a6700' },
  further_assessment: { label: 'Requires further assessment', color: '#7d3cbd' },
  fail: { label: 'Fail', color: '#b03a2e' },
};

const CONTROL: Record<ControlAssessment['status'], { label: string; color: string }> = {
  addressed: { label: 'Addressed in design', color: '#1e8449' },
  gap: { label: 'Gap', color: '#b03a2e' },
  recommended: { label: 'Recommended', color: '#7a7f8c' },
  not_applicable: { label: 'Not applicable', color: '#7a7f8c' },
};

const DATA_PATH = { document: 'Every document', request: 'Per request', none: 'No customer data leaves' } as const;

export function SecurityGovernancePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<SecurityDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<SecurityAssessment | null>(null);
  const [form, setForm] = useState<CreateSecurityAssessmentInput>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<SecurityDefaults>(`/projects/${id}/ai-factory/security-governance/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the assessment inputs.')));
    apiClient
      .get<SecurityAssessment>(`/projects/${id}/ai-factory/security-governance/latest`)
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
      const { data } = await apiClient.post<SecurityAssessment>(`/projects/${id}/ai-factory/security-governance`, form);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not run the security assessment.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const boolField = (k: keyof CreateSecurityAssessmentInput, label: string) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <select value={form[k] === undefined ? '' : String(form[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value === '' ? undefined : e.target.value === 'true' }))}>
        <option value="">Default: No - not stated</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </div>
  );
  const c = defaults?.context;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Security & Governance" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Checks the architecture chosen in the earlier phases against enterprise security requirements. Each component gets a policy status from where it
              processes data - never from who makes it - and each of the spec's 18 control areas is traced to the design that addresses it (
              <Link to={`/projects/${project.id}/inference-architecture`}>Inference Architecture</Link>, <Link to={`/projects/${project.id}/infrastructure-design`}>Infrastructure</Link>,{' '}
              <Link to={`/projects/${project.id}/rag-agent`}>RAG / Agent</Link>). This assesses the design; it does not replace a security review or penetration test.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: '#9a6700' }}>{defaultsError}</div>}
            {defaults && c && (
              <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
                <section className="discovery-section">
                  <div className="discovery-section-header">
                    <span className="discovery-section-index">1</span>
                    <h2 className="discovery-section-title">Vendor agreements</h2>
                  </div>
                  <p className="discovery-section-sub">
                    Data classification <strong>{c.classification}</strong>
                    {[c.containsPii && 'PII', c.containsPhi && 'PHI', c.containsPci && 'PCI'].filter(Boolean).length ? ` (${[c.containsPii && 'PII', c.containsPhi && 'PHI', c.containsPci && 'PCI'].filter(Boolean).join(', ')})` : ''}
                    {c.dataResidency ? `, residency ${c.dataResidency}` : ''}. Everything else comes from the design records
                    {c.missingDesigns.length ? ` - not designed yet: ${c.missingDesigns.join(', ')}` : ''}.
                  </p>
                  <div className="field-grid">
                    {boolField('vendorDpaSigned', 'DPA signed with external vendors')}
                    {boolField('vendorBaaSigned', 'BAA signed with external vendors (PHI)')}
                  </div>
                </section>
                {error && <div className="error-text">{error}</div>}
                <div>
                  <button className="primary-btn" type="submit" disabled={saving}>
                    {saving ? 'Assessing...' : latest ? 'Re-assess (new version)' : 'Run security assessment'}
                  </button>
                </div>
              </form>
            )}
            {latest && <SecurityResultView r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function SecurityResultView({ r, version, createdAt }: { r: SecurityResult; version: number; createdAt: string }) {
  const v = VALIDATION[r.validation.status];
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${v.color}` }}>
        <div className="metric-label">
          AI Security &amp; Governance Assessment · v{version} · {new Date(createdAt).toLocaleString()}
        </div>
        <div className="metric-value" style={{ fontSize: 20 }}>
          Security validation: <span style={{ color: v.color }}>{v.label}</span>
        </div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          Overall policy status <strong style={{ color: POLICY[r.overall.status].color }}>{r.overall.label}</strong> - {r.overall.summary}
        </div>
        <Bullets items={r.validation.reasons} />
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #9a6700' }}>
          <div className="metric-label">Gaps to close</div>
          <Bullets items={r.gaps} />
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Component policy status</div>
        <Table
          headers={['Component', 'Choice', 'Data leaving the boundary', 'Status', 'Why', 'Conditions']}
          rows={r.components.map((c) => [
            <span key="c">
              {c.label}
              <div style={{ fontSize: 11, color: '#7a7f8c' }}>{c.source}</div>
            </span>,
            c.choice,
            c.external ? DATA_PATH[c.dataPath === 'none' ? 'request' : c.dataPath] : DATA_PATH.none,
            <strong key="s" style={{ color: POLICY[c.status].color }}>{POLICY[c.status].label}</strong>,
            c.reasons.join(' '),
            c.conditions.join(' ') || '—',
          ])}
        />
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Control areas (spec §12) - traced to the designs that address them</div>
        <Table
          headers={['Area', 'Requirement', 'Status', 'Addressed in', 'To implement and verify']}
          rows={r.controls.map((c) => [
            c.label,
            c.requirement === 'required' ? `Required - ${c.requiredBy}` : c.requirement === 'recommended' ? 'Recommended' : 'Not applicable',
            <strong key="s" style={{ color: CONTROL[c.status].color }}>{CONTROL[c.status].label}</strong>,
            c.designedIn.length ? (
              <ul key="d" style={{ margin: 0, paddingLeft: 16 }}>
                {c.designedIn.slice(0, 3).map((s, i) => (
                  <li key={i} title={s.text}>
                    {s.source}
                  </li>
                ))}
                {c.designedIn.length > 3 && <li>+{c.designedIn.length - 3} more</li>}
              </ul>
            ) : (
              '—'
            ),
            c.actions.join(' ') || '—',
          ])}
        />
      </div>

      <div className="card-grid">
        <Panel title="Verify before production" items={r.verificationRequired} />
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
