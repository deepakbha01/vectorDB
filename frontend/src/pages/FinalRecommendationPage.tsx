import { ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { FinalRecommendation, FinalResult, Readiness, StageStatus } from '../api/final';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const READINESS: Record<Readiness, string> = { production_ready: 'var(--success)', ready_with_conditions: 'var(--warning)', further_assessment: 'var(--violet)', not_suitable: 'var(--danger)' };
const STAGE: Record<StageStatus, { label: string; color: string }> = {
  pass: { label: 'Pass', color: 'var(--success)' },
  pass_with_conditions: { label: 'Pass with conditions', color: 'var(--warning)' },
  further_assessment: { label: 'Further assessment', color: 'var(--violet)' },
  fail: { label: 'Fail', color: 'var(--danger)' },
};
const PRESENCE = { current: '', stale: 'out of date', missing: 'missing' } as const;
const PLAN_ORDER: Array<[keyof FinalResult['implementationPlan'], string]> = [
  ['build', 'Build'],
  ['deploy', 'Deploy'],
  ['benchmark', 'Benchmark'],
  ['secure', 'Secure'],
  ['operate', 'Operate'],
  ['scale', 'Scale'],
];

export function FinalRecommendationPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [latest, setLatest] = useState<FinalRecommendation | null>(null);
  const [preview, setPreview] = useState<FinalResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<FinalResult>(`/projects/${id}/ai-factory/final/preview`)
      .then((r) => setPreview(r.data))
      .catch((e) => setPreviewError(extractErrorMessage(e, 'Could not build the recommendation.')));
    apiClient
      .get<FinalRecommendation>(`/projects/${id}/ai-factory/final/latest`)
      .then((r) => setLatest(r.data))
      .catch(() => setLatest(null));
  }, [id]);

  const save = async () => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiClient.post<FinalRecommendation>(`/projects/${id}/ai-factory/final`);
      setLatest(data);
      setPreview(data.result);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save the recommendation.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const r = latest?.result ?? preview;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Final Recommendation" />
        {!features.aiFactory && !preview && !previewError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -8, maxWidth: 1000 }}>
              Combines every phase into the final AI architecture and applies the production-readiness gate. Nothing here is decided afresh - each line comes from a
              phase's own decision record (see <Link to={`/projects/${project.id}/ai-factory`}>AI Factory</Link>); out-of-date or missing phases are shown, never filled in.
            </p>
            {previewError && <div className="card" style={{ maxWidth: 900, color: 'var(--warning)' }}>{previewError}</div>}
            <div style={{ marginBottom: 12 }}>
              <button className="primary-btn" type="button" onClick={save} disabled={saving}>
                {saving ? 'Saving...' : latest ? 'Save a new version' : 'Save final recommendation'}
              </button>
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 10 }}>
                {latest ? `Showing saved v${latest.version} · ${new Date(latest.createdAt).toLocaleString()}` : 'Showing a live preview - not saved yet'}
              </span>
              {error && <div className="error-text">{error}</div>}
            </div>
            {r && <FinalView r={r} />}
          </>
        )}
      </div>
    </div>
  );
}

function FinalView({ r }: { r: FinalResult }) {
  const e = r.executiveSummary;
  return (
    <div style={{ maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${READINESS[r.readiness.status]}` }}>
        <div className="metric-label">Production readiness</div>
        <div className="metric-value" style={{ fontSize: 22, color: READINESS[r.readiness.status] }}>{r.readiness.label}</div>
        <Bullets items={r.readiness.reasons} />
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Readiness gate (spec §25)</div>
        <Table
          headers={['Stage', 'Status', 'Reason']}
          rows={r.readiness.stages.map((s) => [s.label, <strong key="s" style={{ color: STAGE[s.status].color, whiteSpace: 'nowrap' }}>{STAGE[s.status].label}</strong>, s.reasons.join(' ')])}
        />
      </div>

      <div className="card">
        <div className="metric-label">Level 1 - Executive summary · confidence {e.confidence}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginTop: 8, fontSize: 13 }}>
          <Fact label="AI use case" value={e.useCase} />
          <Fact label="Recommended architecture" value={e.recommendedArchitecture} />
          <Fact label="Deployment" value={e.deployment} />
          <Fact label="Primary model" value={e.primaryModel} />
          <Fact label="Vector database" value={e.vectorDb} />
          <Fact label="Inference architecture" value={e.inferenceArchitecture} />
          <Fact label="Estimated scale" value={e.estimatedScale} />
        </div>
        {e.keyRisks.length > 0 && (
          <>
            <div className="metric-label" style={{ marginTop: 12 }}>Key risks</div>
            <Bullets items={e.keyRisks} />
          </>
        )}
      </div>

      <div className="card">
        <div className="metric-label" style={{ marginBottom: 10 }}>Level 3 - Final architecture (spec §15)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 6 }}>
          {r.architecture.map((c, i) => (
            <div key={c.step} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ border: `1px solid ${c.status === 'current' ? 'var(--border)' : c.status === 'stale' ? 'var(--warning)' : 'var(--danger-soft)'}`, borderRadius: 8, padding: '8px 10px', background: 'var(--surface-2)', minWidth: 120, maxWidth: 190 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{c.step}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{c.component}</div>
                {c.status !== 'current' && <div style={{ fontSize: 11, color: c.status === 'stale' ? 'var(--warning)' : 'var(--danger)' }}>{PRESENCE[c.status]}</div>}
              </div>
              {i < r.architecture.length - 1 && <span style={{ color: 'var(--muted)' }}>→</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Primary recommendation and alternatives (spec §17)</div>
        <p style={{ fontSize: 13, margin: '6px 0' }}>
          <strong>Primary:</strong> {r.alternatives.primary}
        </p>
        {r.alternatives.options.length > 0 && (
          <Table
            headers={['Alternative', 'Eligibility', 'Strengths', 'Limitations', 'Deployment', 'Cost', 'Risks', 'When to choose']}
            rows={r.alternatives.options.map((o) => [
              <span key="l">
                <strong>{o.label}</strong>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>instead of {o.replaces}</div>
              </span>,
              o.eligibility,
              o.strengths.join('; '),
              o.limitations.join('; ') || '—',
              o.deployment,
              o.costConsiderations,
              o.risks.join('; ') || '—',
              o.whenToChoose,
            ])}
          />
        )}
        {r.alternatives.note && <p style={{ fontSize: 12, color: 'var(--warning)' }}>{r.alternatives.note}</p>}
      </div>

      <div className="card">
        <div className="metric-label">Level 2 - Technical recommendation (explainability, spec §16 / §24)</div>
        {r.technical.map((t) => (
          <details key={t.phase} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
            <summary style={{ cursor: 'pointer', fontSize: 14 }}>
              <strong>{t.title}</strong>: {t.recommendation ?? 'no recommendation'} · {t.status.replace('_', ' ')} · confidence {t.confidence}
              {t.outOfDate && <span style={{ color: 'var(--warning)' }}> · out of date</span>}
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10, marginTop: 8 }}>
              <Small title="Why was this selected?" items={t.why} />
              <Small title="Requirements satisfied" items={t.satisfied} />
              <Small title="Partially satisfied" items={t.partiallySatisfied} />
              <Small title="Not satisfied" items={t.notSatisfied} />
              <Small title="Trade-offs" items={t.tradeoffs} />
              <Small title="Assumptions" items={t.assumptions.slice(0, 6)} />
              <Small title="Evidence" items={t.evidence.slice(0, 8)} />
              <Small title="Benchmark before production" items={t.benchmarkRequired} />
              <Small title="What would change this" items={t.wouldChangeIf} />
            </div>
          </details>
        ))}
      </div>

      <div className="card">
        <div className="metric-label">Architecture Decision Record (spec §18)</div>
        {r.adr.map((s) => (
          <details key={s.number} style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>
              {s.number}. {s.title}
              {s.status !== 'current' && s.source && <span style={{ color: s.status === 'stale' ? 'var(--warning)' : 'var(--danger)' }}> · {PRESENCE[s.status]}</span>}
            </summary>
            <Bullets items={s.lines.length ? s.lines : ['—']} />
          </details>
        ))}
      </div>

      <div className="card">
        <div className="metric-label">Level 4 - Implementation plan</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10, marginTop: 8 }}>
          {PLAN_ORDER.map(([k, label]) => (
            <Small key={k} title={label} items={r.implementationPlan[k]} />
          ))}
        </div>
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--warning)' }}>
          <div className="metric-label">Open gaps across the assessment</div>
          <Bullets items={r.gaps} />
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Small({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {items.length ? <Bullets items={items} /> : <div style={{ fontSize: 13, color: 'var(--muted)' }}>—</div>}
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
          {headers.map((h, i) => (
            <th key={i} style={{ padding: '6px 8px' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
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
