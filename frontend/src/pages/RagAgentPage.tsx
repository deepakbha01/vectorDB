import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { Eligibility } from '../api/aiFactory';
import { CreateRagAgentDesignInput, RagAgentDefaults, RagAgentDesign, RagAgentResult, TOOL_ACCESS, ToolAccess } from '../api/ragAgent';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const ELIGIBILITY: Record<Eligibility, { label: string; color: string }> = {
  eligible: { label: 'Eligible', color: 'var(--success)' },
  conditional: { label: 'Conditional', color: 'var(--warning)' },
  not_eligible: { label: 'Not eligible', color: 'var(--danger)' },
  not_assessed: { label: 'Not assessed', color: 'var(--muted)' },
};

const RAG_SECTIONS: Array<[keyof NonNullable<RagAgentResult['rag']>, string]> = [
  ['semanticSearch', 'Semantic search'],
  ['hybridSearch', 'Hybrid search'],
  ['metadataFiltering', 'Metadata filtering'],
  ['reranking', 'Reranking'],
  ['contextConstruction', 'Context construction'],
  ['promptConstruction', 'Prompt construction'],
  ['citation', 'Citation'],
  ['grounding', 'Grounding'],
  ['hallucinationMitigation', 'Hallucination mitigation'],
];

const AGENT_SECTIONS: Array<[keyof NonNullable<RagAgentResult['agent']>, string]> = [
  ['orchestration', 'Orchestration'],
  ['toolCalling', 'Tool calling'],
  ['memory', 'Memory'],
  ['planning', 'Planning'],
  ['guardrails', 'Guardrails'],
  ['humanApproval', 'Human approval'],
  ['toolSecurity', 'Tool security'],
  ['isolation', 'Agent isolation'],
];

type BoolKey = 'includeRag' | 'includeAgent' | 'citationsRequired' | 'multiTurn' | 'openEndedTasks' | 'longTermMemory';
const DEFAULT_KEY: Record<BoolKey, 'rag' | 'agent' | 'citationsRequired' | 'multiTurn' | 'openEndedTasks' | 'longTermMemory'> = {
  includeRag: 'rag',
  includeAgent: 'agent',
  citationsRequired: 'citationsRequired',
  multiTurn: 'multiTurn',
  openEndedTasks: 'openEndedTasks',
  longTermMemory: 'longTermMemory',
};

export function RagAgentPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<RagAgentDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<RagAgentDesign | null>(null);
  const [form, setForm] = useState<CreateRagAgentDesignInput>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<RagAgentDefaults>(`/projects/${id}/ai-factory/rag-agent/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the design inputs.')));
    apiClient
      .get<RagAgentDesign>(`/projects/${id}/ai-factory/rag-agent/latest`)
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
      const { data } = await apiClient.post<RagAgentDesign>(`/projects/${id}/ai-factory/rag-agent`, form);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not design the RAG / agent architecture.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const boolField = (k: BoolKey, label: string) => {
    const d = defaults?.context[DEFAULT_KEY[k]];
    const s = defaults?.sources[k];
    return (
      <div className="field" key={k}>
        <label>{label}</label>
        <select value={form[k] === undefined ? '' : String(form[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value === '' ? undefined : e.target.value === 'true' }))}>
          <option value="">{d === undefined ? 'Default' : `Default: ${d ? 'Yes' : 'No'}${s ? ` - ${s.detail}` : ''}`}</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </div>
    );
  };
  const toolDefault = defaults ? TOOL_ACCESS.find(([v]) => v === defaults.context.toolAccess)?.[1] : null;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="RAG / Agent Architecture" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -8, maxWidth: 1000 }}>
              Combines the application, <Link to={`/projects/${project.id}/vector-db-selection`}>vector database</Link>, embeddings, reranker,{' '}
              <Link to={`/projects/${project.id}/model-selection`}>models</Link>, <Link to={`/projects/${project.id}/inference-architecture`}>inference</Link> and tools into
              the GenAI application architecture. Retrieval, reranking and agent orchestration are each checked for eligibility before they are scored; latency and
              context figures are estimates until the Performance phase measures them.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: 'var(--warning)' }}>{defaultsError}</div>}
            {defaults && (
              <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
                <section className="discovery-section">
                  <div className="discovery-section-header">
                    <span className="discovery-section-index">1</span>
                    <h2 className="discovery-section-title">Scope and application behaviour</h2>
                  </div>
                  <p className="discovery-section-sub">
                    Everything else comes from earlier phases: vector database <strong>{defaults.context.vectorPlatform ?? 'not chosen'}</strong>, embeddings{' '}
                    <strong>{defaults.context.embeddingModel ?? 'not chosen'}</strong>, top-K {defaults.context.topK}, primary model{' '}
                    <strong>{defaults.context.primary?.label ?? 'not selected'}</strong>.
                  </p>
                  <div className="field-grid">
                    {boolField('includeRag', 'Design the RAG layer')}
                    {boolField('includeAgent', 'Design the agent layer')}
                    {boolField('citationsRequired', 'Answers cite sources')}
                    {boolField('multiTurn', 'Conversational (multi-turn)')}
                    <div className="field">
                      <label>Agent tool access</label>
                      <select value={form.toolAccess ?? ''} onChange={(e) => setForm((f) => ({ ...f, toolAccess: e.target.value === '' ? undefined : (e.target.value as ToolAccess) }))}>
                        <option value="">{`Default: ${toolDefault ?? '-'}${defaults.sources.toolAccess ? ` - ${defaults.sources.toolAccess.detail}` : ''}`}</option>
                        {TOOL_ACCESS.map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {boolField('openEndedTasks', 'Agent tasks are open-ended')}
                    {boolField('longTermMemory', 'Remember users across sessions')}
                  </div>
                </section>
                {error && <div className="error-text">{error}</div>}
                <div>
                  <button className="primary-btn" type="submit" disabled={saving}>
                    {saving ? 'Designing...' : latest ? 'Re-design (new version)' : 'Design RAG / agent architecture'}
                  </button>
                </div>
              </form>
            )}
            {latest && <RagAgentResultView r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
          </>
        )}
      </div>
    </div>
  );
}

function RagAgentResultView({ r, version, createdAt }: { r: RagAgentResult; version: number; createdAt: string }) {
  const lb = r.latencyBudget;
  const verdict = (ok: boolean | null) => (ok === null ? '—' : <strong style={{ color: ok ? 'var(--success)' : 'var(--danger)' }}>{ok ? 'Within target' : 'Exceeds target'}</strong>);
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${r.decisions.every((d) => d.chosen) ? 'var(--primary-text)' : 'var(--danger)'}` }}>
        <div className="metric-label">
          GenAI Application Architecture · v{version} · {new Date(createdAt).toLocaleString()} · confidence {r.confidence}
        </div>
        <div className="metric-value" style={{ fontSize: 20 }}>{r.scope.summary}</div>
        <Bullets items={r.decisions.map((d) => `${d.title}: ${d.why}`)} />
      </div>

      <div className="card">
        <div className="metric-label" style={{ marginBottom: 10 }}>Application architecture (spec §19)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 6 }}>
          {r.components.map((c, i) => (
            <div key={c.layer} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface-2)', minWidth: 130, maxWidth: 210 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{c.layer}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{c.component}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.detail}</div>
              </div>
              {i < r.components.length - 1 && <span style={{ color: 'var(--muted)' }}>→</span>}
            </div>
          ))}
        </div>
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--warning)' }}>
          <div className="metric-label">Gaps to close</div>
          <Bullets items={r.gaps} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Latency budget - estimates and assumptions, not measurements</div>
          <Table headers={['Stage', 'ms', 'Evidence', '']} rows={lb.lines.map((l) => [l.stage, l.ms.toLocaleString(), l.evidenceType.replace('_', '-'), l.detail])} />
          <Table
            headers={['', 'Estimate', 'Target', '']}
            rows={[
              ['Time to first token', lb.timeToFirstTokenMs === null ? '—' : `${lb.timeToFirstTokenMs.toLocaleString()} ms`, lb.ttftTargetMs === null ? '—' : `${lb.ttftTargetMs.toLocaleString()} ms`, verdict(lb.meetsTtftTarget)],
              ['End-to-end response', lb.endToEndMs === null ? '—' : `${lb.endToEndMs.toLocaleString()} ms`, lb.e2eTargetMs === null ? '—' : `${lb.e2eTargetMs.toLocaleString()} ms`, verdict(lb.meetsE2eTarget)],
            ]}
          />
        </div>
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Context window budget</div>
          <Table headers={['', 'Tokens', 'Evidence']} rows={r.contextBudget.lines.map((l) => [l.label, l.tokens.toLocaleString(), l.evidenceType.replace('_', '-')])} />
          <p style={{ fontSize: 13, marginTop: 8, color: r.contextBudget.fits === false ? 'var(--danger)' : 'var(--text)' }}>{r.contextBudget.note}</p>
        </div>
      </div>

      {r.rag && (
        <>
          <h3 style={{ margin: '8px 0 0' }}>RAG assessment</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            {RAG_SECTIONS.map(([k, title]) => (
              <Panel key={k} title={title} items={r.rag![k]} />
            ))}
          </div>
        </>
      )}
      {r.agent && (
        <>
          <h3 style={{ margin: '8px 0 0' }}>Agent assessment</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            {AGENT_SECTIONS.map(([k, title]) => (
              <Panel key={k} title={title} items={r.agent![k]} />
            ))}
          </div>
        </>
      )}

      {r.decisions.map((d) => (
        <div key={d.area} className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">{d.title} - options (eligibility is decided before scoring)</div>
          <Table
            headers={['Option', 'Eligibility', 'Score', 'Why']}
            rows={d.candidates.map((c) => [
              d.chosen?.id === c.id ? <strong key="l">{c.label}</strong> : c.label,
              <span key="e" style={{ color: ELIGIBILITY[c.eligibility].color, fontWeight: 600 }}>{ELIGIBILITY[c.eligibility].label}</span>,
              c.score.toFixed(3),
              [...c.failures, ...c.conditions, ...c.notes].join(' ') || '—',
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
      {items.length ? <Bullets items={items} /> : <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>Nothing specific.</div>}
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
