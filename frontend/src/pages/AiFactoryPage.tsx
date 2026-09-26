import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import {
  AiFactoryOverview,
  AssessmentState,
  DecisionRecord,
  Eligibility,
  EvidenceType,
  ImpactAnalysis,
  SnapshotComparison,
  SnapshotSummary,
  StepState,
  StepStatus,
} from '../api/aiFactory';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const STATUS_STYLE: Record<StepStatus, { label: string; color: string; bg: string }> = {
  current: { label: 'Current', color: '#1e8449', bg: '#eaf7ef' },
  stale: { label: 'Out of date', color: '#b03a2e', bg: '#fdecea' },
  review: { label: 'Review', color: '#9a6700', bg: '#fff6dd' },
  in_progress: { label: 'In progress', color: '#2f6fde', bg: '#eaf1fd' },
  not_started: { label: 'Not started', color: '#5a6472', bg: '#f1f3f5' },
  not_yet_available: { label: 'Coming soon', color: '#7a7f8c', bg: '#f5f5f7' },
};
const EVIDENCE_STYLE: Record<EvidenceType, { label: string; color: string }> = {
  measured: { label: 'Measured', color: '#1e8449' },
  estimated: { label: 'Estimated', color: '#2f6fde' },
  vendor_listed: { label: 'Vendor-listed', color: '#6b3fa0' },
  assumption: { label: 'Assumption', color: '#9a6700' },
};
const ELIGIBILITY_STYLE: Record<Eligibility, { label: string; color: string }> = {
  eligible: { label: 'Eligible', color: '#1e8449' },
  conditional: { label: 'Conditional', color: '#9a6700' },
  not_eligible: { label: 'Not eligible', color: '#b03a2e' },
  not_assessed: { label: 'Not assessed', color: '#7a7f8c' },
};
const STEP_SECTIONS: Record<string, Array<keyof AssessmentState>> = {
  use_case: ['useCase'],
  scale: ['scale'],
  data_embedding: ['data', 'embedding'],
  vectordb_index: ['vectorDB', 'index'],
  model: ['model'],
  inference: ['inference'],
  token_observability: ['tokenObservability'],
  infrastructure: ['infrastructure'],
  rag_agent: ['rag'],
  security: ['security'],
  performance: ['performance'],
  cost: ['cost'],
  operations: ['operations'],
  final: ['recommendation'],
};

const pad = (n: number) => String(n).padStart(2, '0');
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function AiFactoryPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [overview, setOverview] = useState<AiFactoryOverview | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [selected, setSelected] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);

  const load = useCallback(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<AiFactoryOverview>(`/projects/${id}/ai-factory`)
      .then((r) => {
        setOverview(r.data);
        setError(null);
      })
      .catch((e) => setError(extractErrorMessage(e, 'Could not load the AI Factory view.')));
    apiClient.get<DecisionRecord[]>(`/projects/${id}/ai-factory/decisions`).then((r) => setDecisions(r.data)).catch(() => setDecisions([]));
    apiClient.get<SnapshotSummary[]>(`/projects/${id}/ai-factory/snapshots`).then((r) => setSnapshots(r.data)).catch(() => setSnapshots([]));
  }, [id]);

  useEffect(load, [load]);

  if (!project) return <div className="main-content">Loading...</div>;

  const step = overview?.steps.find((s) => s.number === selected);
  const counts = overview ? overview.steps.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {}) : {};

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="AI Factory Assessment" />
        {!features.aiFactory && !overview && (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory guided workflow is not enabled on this server. An administrator can turn it on with <code>AI_FACTORY_ENABLED=true</code>; the existing phases are unaffected either way.
          </div>
        )}
        {error && features.aiFactory && <div className="error-text">{error}</div>}

        {overview && step && (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              A guided view over the existing phases: what each step has decided, whether it is still current, and what an upstream change affects. It reads the phases; it never changes them.
              {' '}
              <span style={{ whiteSpace: 'nowrap' }}>
                {Object.entries(counts).map(([k, n]) => (
                  <StatusPill key={k} status={k as StepStatus} suffix={` ${n}`} />
                ))}
              </span>
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '250px minmax(0, 1fr)', gap: 20, alignItems: 'start', maxWidth: 1250 }}>
              <StepList steps={overview.steps} selected={selected} onSelect={setSelected} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
                <StepDetail
                  step={step}
                  overview={overview}
                  projectId={project.id}
                  decisions={decisions.filter((d) => step.phases.includes(d.phase))}
                  onNext={selected < overview.steps.length ? () => setSelected(selected + 1) : undefined}
                />
                <Snapshots projectId={project.id} snapshots={snapshots} onSaved={load} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ steps

function StepList({ steps, selected, onSelect }: { steps: StepState[]; selected: number; onSelect: (n: number) => void }) {
  return (
    <nav className="card" style={{ padding: 8, position: 'sticky', top: 12 }}>
      {steps.map((s) => (
        <button
          key={s.number}
          type="button"
          onClick={() => onSelect(s.number)}
          style={{
            display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
            background: s.number === selected ? '#eaf1fd' : 'transparent', fontWeight: s.number === selected ? 600 : 400, fontSize: 13,
          }}
        >
          <span style={{ color: '#7a7f8c', fontVariantNumeric: 'tabular-nums' }}>{pad(s.number)}</span>
          <span style={{ flex: 1 }}>{s.title}</span>
          <StatusDot status={s.status} />
        </button>
      ))}
    </nav>
  );
}

function StepDetail({ step, overview, projectId, decisions, onNext }: { step: StepState; overview: AiFactoryOverview; projectId: string; decisions: DecisionRecord[]; onNext?: () => void }) {
  const lineage = overview.phases.filter((p) => step.phases.includes(p.phase));
  const sections = STEP_SECTIONS[step.key] ?? [];
  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>
            {pad(step.number)} · {step.title}
          </h3>
          <span>
            <StatusPill status={step.status} />
            <span className="status-pill" style={{ marginLeft: 6 }}>
              {step.coverage === 'full' ? 'Full spec coverage' : step.coverage === 'partial' ? `Partial - more in Wave ${step.plannedWave}` : `Arrives in Wave ${step.plannedWave}`}
            </span>
          </span>
        </div>
        {step.note && <p style={{ fontSize: 13, color: '#5a6472', margin: '8px 0 0' }}>{step.note}</p>}

        {lineage.length > 0 && (
          <Table
            headers={['Phase', 'Status', 'Version', 'Built from', 'Why', '']}
            rows={lineage.map((l) => [
              l.label,
              <StatusPill key="s" status={l.status} />,
              l.latest ? `v${l.latest.version}` : '—',
              l.upstream.length ? l.upstream.map((u) => `${u.phase.replace(/_/g, ' ')} v${u.builtFromVersion ?? '-'}${u.changedSinceBuilt ? ` (now v${u.latestVersion})` : ''}`).join(', ') : '—',
              <span key="r">
                {l.reasons.map((r) => (
                  <div key={r.message}>{r.message}</div>
                ))}
                {l.changedDiscoveryFields?.length ? <div style={{ color: '#5a6472' }}>Changed answers: {l.changedDiscoveryFields.join(', ')}</div> : null}
                {!l.reasons.length && l.latest ? 'Up to date' : null}
              </span>,
              <Link key="o" to={`/projects/${projectId}/${l.route}`}>
                Open →
              </Link>,
            ])}
          />
        )}
        {step.key === 'use_case' && (
          <p style={{ fontSize: 13, color: '#5a6472', margin: '8px 0 0' }}>
            Captured when the project was created. A dedicated AI Workload Profile (criticality, users, workload type, data types) arrives in Wave 2.
          </p>
        )}
      </div>

      {step.key === 'scale' && <ImpactPanel projectId={projectId} versions={overview.phases.find((p) => p.phase === 'discovery')?.versions ?? 0} />}

      {decisions.map((d) => (
        <DecisionCard key={d.phase} d={d} />
      ))}

      {sections.map((key) => {
        const s = overview.state[key];
        return (
          <div className="card" key={key}>
            <div className="metric-label" style={{ marginBottom: 6 }}>
              Assessment state · {key} {s.source ? `· from ${s.source.phase.replace(/_/g, ' ')} v${s.source.version}` : ''}
            </div>
            {s.status === 'not_yet_available' ? (
              <p style={{ fontSize: 13, color: '#5a6472', margin: 0 }}>Not part of the application yet - planned for Wave {s.plannedWave}.</p>
            ) : Object.keys(s.summary).length ? (
              <Table headers={['Field', 'Value']} rows={Object.entries(s.summary).map(([k, v]) => [k, show(v)])} />
            ) : (
              <p style={{ fontSize: 13, color: '#5a6472', margin: 0 }}>Nothing recorded yet.</p>
            )}
          </div>
        );
      })}

      {onNext && (
        <div>
          <button type="button" className="primary-btn" onClick={onNext}>
            Next step →
          </button>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------- decision record

function DecisionCard({ d }: { d: DecisionRecord }) {
  const [showCandidates, setShowCandidates] = useState(false);
  return (
    <div className="card" style={{ borderLeft: `4px solid ${d.status === 'not_feasible' ? '#b03a2e' : d.status === 'decided' ? '#2f6fde' : '#9a6700'}` }}>
      <div className="metric-label">
        {d.title} decision · v{d.source.version} · {d.status.replace('_', ' ')} · confidence {d.confidence.replace('_', ' ')}
      </div>
      <div className="metric-value" style={{ fontSize: 20 }}>{d.recommendation?.label ?? 'No recommendation'}</div>
      <Bullets title="Why" items={d.why} />
      {d.alternatives.length > 0 && (
        <Table
          headers={['Alternative', 'Eligibility', 'Notes']}
          rows={d.alternatives.map((a) => [a.label, <Eligible key="e" e={a.eligibility} />, a.reason])}
        />
      )}
      <button type="button" onClick={() => setShowCandidates((s) => !s)} style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, color: '#2f6fde', cursor: 'pointer', fontSize: 13 }}>
        {showCandidates ? 'Hide' : 'Show'} all {d.candidates.length} candidates{d.candidates.some((c) => c.eligibility !== 'not_assessed') ? ' (eligibility is checked before scoring)' : ''}
      </button>
      {showCandidates && (
        <Table
          headers={['Candidate', 'Eligibility', 'Score', 'Notes']}
          rows={d.candidates.map((c) => [c.label, <Eligible key="e" e={c.eligibility} />, c.score === null ? '—' : c.score.toFixed(3), c.notes.slice(0, 3).join('; ')])}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 8 }}>
        <Bullets title="Trade-offs" items={d.tradeoffs} />
        <Bullets title="Risks" items={d.risks} />
        <Bullets title="Benchmark before production" items={d.benchmarkRequired} />
        <Bullets title="What would change this" items={d.wouldChangeIf} />
      </div>
      {d.evidence.length > 0 && (
        <Table headers={['Evidence', 'Value', 'Type']} rows={d.evidence.map((e) => [e.label, e.value, <EvidenceChip key="t" t={e.evidenceType} />])} />
      )}
      {d.assumptions.length > 0 && <Table headers={['Assumption', 'Type']} rows={d.assumptions.map((a) => [a.statement, <EvidenceChip key="t" t={a.evidenceType} />])} />}
      {d.gaps.length > 0 && <Bullets title="Not covered yet" items={d.gaps} muted />}
    </div>
  );
}

// ------------------------------------------------------------ impact

function ImpactPanel({ projectId, versions }: { projectId: string; versions: number }) {
  const [from, setFrom] = useState(Math.max(1, versions - 1));
  const [to, setTo] = useState(versions);
  const [impact, setImpact] = useState<ImpactAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (versions < 1) return;
    apiClient
      .get<ImpactAnalysis>(`/projects/${projectId}/ai-factory/impact`, { params: { from, to } })
      .then((r) => {
        setImpact(r.data);
        setError(null);
      })
      .catch((e) => setError(extractErrorMessage(e, 'Could not analyse impact.')));
  }, [projectId, from, to, versions]);

  const options = useMemo(() => Array.from({ length: versions }, (_, i) => i + 1), [versions]);
  if (versions < 2) {
    return (
      <div className="card">
        <div className="metric-label">Impact analysis</div>
        <p style={{ fontSize: 13, color: '#5a6472', margin: '6px 0 0' }}>Re-submit Discovery with changed answers to see which phases need re-running.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="metric-label" style={{ marginBottom: 6 }}>
        Impact analysis - which phases a Discovery change affects
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        Compare Discovery
        <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
          {options.map((v) => (
            <option key={v} value={v}>
              v{v}
            </option>
          ))}
        </select>
        with
        <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
          {options.map((v) => (
            <option key={v} value={v}>
              v{v}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="error-text">{error}</div>}
      {impact && (
        <>
          {impact.changes.length === 0 ? (
            <p style={{ fontSize: 13, margin: '8px 0 0' }}>No answers changed between these versions.</p>
          ) : (
            <Table
              headers={['Changed answer', 'From', 'To', 'Read directly by']}
              rows={impact.changes.map((c) => [c.field, show(c.from), show(c.to), c.directPhases.length ? c.directPhases.map((p) => p.replace(/_/g, ' ')).join(', ') : <em key="n">no engine reads this today</em>])}
            />
          )}
          {impact.affected.length > 0 && (
            <Table
              headers={['Phase', 'Action', 'Because']}
              rows={impact.affected.map((a) => [a.label, <strong key="a" style={{ color: a.action === 'rerun' ? '#b03a2e' : '#9a6700' }}>{a.action === 'rerun' ? 'Re-run' : 'Review'}</strong>, a.because.join('; ')])}
            />
          )}
          {impact.unaffected.length > 0 && impact.changes.length > 0 && (
            <p style={{ fontSize: 12, color: '#5a6472', margin: '8px 0 0' }}>Not affected: {impact.unaffected.map((u) => u.label).join(', ')}.</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------- snapshots

function Snapshots({ projectId, snapshots, onSaved }: { projectId: string; snapshots: SnapshotSummary[]; onSaved: () => void }) {
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cmp, setCmp] = useState<SnapshotComparison | null>(null);
  const [from, setFrom] = useState<number | ''>('');
  const [to, setTo] = useState<number | ''>('');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${projectId}/ai-factory/snapshots`, { label: label || undefined });
      setLabel('');
      onSaved();
    } catch (e) {
      setError(extractErrorMessage(e, 'Could not save the snapshot.'));
    } finally {
      setSaving(false);
    }
  };
  const compare = async () => {
    if (from === '' || to === '') return;
    try {
      const r = await apiClient.get<SnapshotComparison>(`/projects/${projectId}/ai-factory/snapshots/compare`, { params: { from, to } });
      setCmp(r.data);
      setError(null);
    } catch (e) {
      setError(extractErrorMessage(e, 'Could not compare snapshots.'));
    }
  };

  return (
    <div className="card">
      <div className="metric-label" style={{ marginBottom: 6 }}>
        Assessment history - save the current state to compare runs later
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Label (optional), e.g. 'Before customer workshop'" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} style={{ flex: '1 1 260px', padding: 6 }} />
        <button type="button" className="primary-btn" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save snapshot'}
        </button>
      </div>
      {snapshots.length > 0 && (
        <>
          <Table headers={['Version', 'Label', 'Saved']} rows={snapshots.map((s) => [`v${s.version}`, s.label ?? '—', new Date(s.createdAt).toLocaleString()])} />
          {snapshots.length > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 8 }}>
              Compare
              <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                <option value="">…</option>
                {snapshots.map((s) => (
                  <option key={s.version} value={s.version}>
                    v{s.version}
                  </option>
                ))}
              </select>
              with
              <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
                <option value="">…</option>
                {snapshots.map((s) => (
                  <option key={s.version} value={s.version}>
                    v{s.version}
                  </option>
                ))}
              </select>
              <button type="button" className="primary-btn" onClick={compare} disabled={from === '' || to === ''}>
                Compare
              </button>
            </div>
          )}
        </>
      )}
      {error && <div className="error-text">{error}</div>}
      {cmp && (
        <Table
          headers={['Section', 'Change', 'Status', 'Changed fields']}
          rows={cmp.sections.filter((s) => s.change === 'changed').map((s) => [s.section, 'Changed', `${s.statusFrom} → ${s.statusTo}`, s.changedFields.join(', ')])}
        />
      )}
      {cmp && cmp.sections.every((s) => s.change === 'unchanged') && <p style={{ fontSize: 13 }}>No differences between v{cmp.from} and v{cmp.to}.</p>}
    </div>
  );
}

// ------------------------------------------------------------ helpers

function StatusPill({ status, suffix = '' }: { status: StepStatus; suffix?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className="status-pill" style={{ color: s.color, background: s.bg, marginRight: 4 }}>
      {s.label}
      {suffix}
    </span>
  );
}

function StatusDot({ status }: { status: StepStatus }) {
  const s = STATUS_STYLE[status];
  return <span title={s.label} style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, opacity: status === 'not_yet_available' ? 0.35 : 1, flexShrink: 0 }} />;
}

function EvidenceChip({ t }: { t: EvidenceType }) {
  const s = EVIDENCE_STYLE[t];
  return <span style={{ color: s.color, fontWeight: 600, fontSize: 12 }}>{s.label}</span>;
}

function Eligible({ e }: { e: Eligibility }) {
  const s = ELIGIBILITY_STYLE[e];
  return <span style={{ color: s.color, fontWeight: 600, fontSize: 12 }}>{s.label}</span>;
}

function Bullets({ title, items, muted }: { title: string; items: string[]; muted?: boolean }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#5a6472' }}>{title}</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, color: muted ? '#5a6472' : undefined }}>
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
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
    </div>
  );
}
