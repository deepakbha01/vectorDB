import { ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, PatternCatalogEntry } from '../api/client';
import { TopBar } from '../components/TopBar';
import { CUSTOMER_QUESTIONS, DECISION_STEPS, QUICK_MATRIX, STACK_PROFILES, STORAGE_TIERS, SUPPORT_GUIDANCE, stackLabel } from '../content/infraFitmentGuide';

function list(title: string, items: string[]) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="metric-label">{title}</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

const LLM_USAGE = { required: 'Required', optional: 'Optional', none: 'No LLM / vector-only' } as const;
const NOT_CONFIGURED = <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>Not configured</span>;
const orNot = (v: number | null | undefined, suffix = '') => (v === null || v === undefined ? NOT_CONFIGURED : `${v}${suffix}`);
const DIRECTIONAL = 'Directional reference - confirm current models, NVIDIA certifications, support terms and pricing with each vendor. The Infrastructure Design phase picks the stack from the project\'s own inputs.';

type Tab = 'patterns' | 'infrastructure';

/** The pattern's token metadata: only what it can honestly say; the rest is set per project on Token Observability. */
function tokenProfile(p: PatternCatalogEntry) {
  const t = p.tokenObservabilityProfile;
  if (!t) return null;
  const rows: Array<[string, ReactNode]> = [
    ['Workload type', t.workloadType.replace('_', ' ')],
    ['LLM usage', LLM_USAGE[t.llmUsage]],
    ['Requests that call the LLM', orNot(t.llmRequestSharePercent, '%')],
    ['LLM calls per request', orNot(t.llmCallsPerRequest)],
    ['Agent steps per task', orNot(t.agentStepsPerRequest)],
    ['Search QPS (seeds Discovery)', orNot(p.defaultAssessment.qps as number | undefined)],
    ['Token sizes, utilization, retry and cache rates', NOT_CONFIGURED],
  ];
  return (
    <div className="card" style={{ marginTop: 12, borderLeft: '4px solid var(--primary-text)' }}>
      <div className="metric-label">Token Observability profile - pattern defaults (editable per project)</div>
      <table style={{ fontSize: 13, marginTop: 6, borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: '2px 16px 2px 0', color: 'var(--muted)' }}>{k}</td>
              <td style={{ padding: '2px 0' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {t.llmUsage === 'optional' && <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 6 }}>Search QPS is not LLM QPS - set the share of requests that call an LLM on the project's Token Observability page.</div>}
      {list('Token guidance', t.guidance)}
    </div>
  );
}

/** Per-pattern on-premises fitment (Wave 13): reference for consultants, seeds nothing. */
function infrastructureFitment(p: PatternCatalogEntry, openGuide: () => void) {
  const f = p.infrastructureFitment;
  if (!f) return null;
  return (
    <div className="card" style={{ marginTop: 12, borderLeft: '4px solid var(--violet)' }}>
      <div className="metric-label">Infrastructure fitment - reference for consultants</div>
      <div style={{ fontSize: 13, marginTop: 4 }}>
        <strong>Typical footprint:</strong> {f.footprint}
      </div>
      <div style={{ fontSize: 13, marginTop: 4 }}>
        <strong>Usually fits:</strong> {f.primaryStacks.map(stackLabel).join('; ')}
        {f.alternativeStacks.length > 0 && (
          <>
            {' '}
            · <span style={{ color: 'var(--muted)' }}>also consider: {f.alternativeStacks.map(stackLabel).join('; ')}</span>
          </>
        )}
      </div>
      <div style={{ fontSize: 13, marginTop: 4 }}>
        <strong>Cloud first when:</strong> {f.cloudFirstWhen}
      </div>
      <div className="card-grid" style={{ marginTop: 4 }}>
        <div>{list('Why', f.why)}</div>
        <div>{list('Storage must do well', f.storageEmphasis)}</div>
        <div>{list('Watch-outs', f.watchOuts)}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
        {DIRECTIONAL}{' '}
        <button type="button" onClick={openGuide} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary-text)', cursor: 'pointer', fontSize: 12 }}>
          Open the infrastructure fitment guide
        </button>
      </div>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
            {headers.map((h) => (
              <th key={h} style={{ padding: '6px 8px' }}>
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
    </div>
  );
}

const bullets = (items: string[]) => (
  <ul style={{ margin: 0, paddingLeft: 16 }}>
    {items.map((i) => (
      <li key={i}>{i}</li>
    ))}
  </ul>
);

/** Wave 13: how to choose on-premises compute and storage - a consultant reference. */
function InfrastructureGuide({ patterns }: { patterns: PatternCatalogEntry[] | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1150 }}>
      <div className="card" style={{ borderLeft: '4px solid var(--violet)' }}>
        <div className="card-title">Choosing infrastructure, compute and storage for an AI factory</div>
        <p style={{ fontSize: 13, marginTop: 6 }}>
          A reference for consultants deciding between Nutanix, Dell (including the former EMC storage line), NetApp, VAST Data and DDN for on-premises AI workloads. Work through the
          five questions, use the matrix for a first answer, then confirm it on the project's{' '}
          <strong>Infrastructure Design</strong> page, which scores every stack against the project's own sizing, estate and DR targets.
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{DIRECTIONAL}</p>
      </div>

      <div className="card">
        <div className="metric-label">Decide in five questions</div>
        <ol style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
          {DECISION_STEPS.map((s) => (
            <li key={s.title} style={{ marginBottom: 10 }}>
              <strong>{s.title}</strong> <span style={{ color: 'var(--muted)' }}>- {s.ask}</span>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {s.guidance.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      <div className="card">
        <div className="metric-label">Quick decision matrix</div>
        <Table headers={['Situation', 'First choice', 'Alternative', 'Why']} rows={QUICK_MATRIX.map((m) => [m.situation, <strong key="f">{stackLabel(m.first)}</strong>, stackLabel(m.alternative), m.why])} />
      </div>

      <div className="card">
        <div className="metric-label">Stack profiles</div>
        <Table
          headers={['Stack', 'Best for', 'GPU range', 'Strengths', 'Watch-outs', 'Cloud extension', 'Support']}
          rows={STACK_PROFILES.map((s) => [
            <div key="l">
              <strong>{s.label}</strong>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.vendors}</div>
            </div>,
            s.bestFor,
            s.gpuRange,
            bullets(s.strengths),
            bullets(s.watchOuts),
            s.cloudExtension,
            s.support,
          ])}
        />
      </div>

      <div className="card">
        <div className="metric-label">Storage tiers in an AI workload</div>
        <Table headers={['Tier', 'Holds', 'What matters']} rows={STORAGE_TIERS.map((t) => [<strong key="t">{t.tier}</strong>, t.holds, t.matters])} />
      </div>

      {patterns && patterns.some((p) => p.infrastructureFitment) && (
        <div className="card">
          <div className="metric-label">By pattern</div>
          <Table
            headers={['Pattern', 'Typical footprint', 'Usually fits', 'Also consider']}
            rows={patterns
              .filter((p) => p.infrastructureFitment)
              .map((p) => [<strong key="n">{p.name}</strong>, p.infrastructureFitment!.footprint, p.infrastructureFitment!.primaryStacks.map(stackLabel).join('; '), p.infrastructureFitment!.alternativeStacks.map(stackLabel).join('; ') || '—'])}
          />
        </div>
      )}

      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Questions to ask the customer</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{bullets(CUSTOMER_QUESTIONS)}</div>
        </div>
        <div className="card">
          <div className="metric-label">Customer support model</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{bullets(SUPPORT_GUIDANCE)}</div>
        </div>
      </div>
    </div>
  );
}

export function PatternLibraryPage() {
  const [patterns, setPatterns] = useState<PatternCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('patterns');

  useEffect(() => {
    apiClient
      .get<PatternCatalogEntry[]>('/projects/pattern-catalog')
      .then((res) => setPatterns(res.data))
      .catch(() => setError('Could not load the pattern library.'));
  }, []);

  const openGuide = () => {
    setTab('infrastructure');
    window.scrollTo({ top: 0 });
  };
  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      className={tab === t ? 'primary-btn' : 'secondary-btn'}
      style={{ padding: '6px 14px', fontSize: 13 }}
      aria-pressed={tab === t}
    >
      {label}
    </button>
  );

  return (
    <div className="main-content">
      <TopBar title="AI Factory Pattern Library" />
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 760, marginBottom: 12 }}>
        Reusable, configurable starting points for a new project. Picking a pattern on{' '}
        <Link to="/projects/new">project creation</Link> seeds Phase 1 Discovery with typical defaults for that use
        case - every value stays fully editable, and Phase 4 (Vector DB Selection) still qualifies and scores
        candidate platforms from scratch regardless of which pattern (if any) was used.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {tabBtn('patterns', 'Patterns')}
        {tabBtn('infrastructure', 'Infrastructure fitment guide')}
      </div>

      {tab === 'infrastructure' ? (
        <InfrastructureGuide patterns={patterns} />
      ) : (
        <>
          {error && <p className="error-text">{error}</p>}
          {!patterns && !error && <p>Loading...</p>}

          {patterns?.map((p) => (
            <div key={p.id} className="card" style={{ marginBottom: 16 }}>
              <div className="card-title">
                {p.name}
              </div>
              <span className="status-pill">{p.industry}</span>
              <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>{p.description}</p>

              <div className="card-grid" style={{ marginTop: 12 }}>
                <div className="card">
                  <div className="metric-label">Typical data types</div>
                  <div style={{ fontSize: 13 }}>{p.typicalDataTypes.join(', ')}</div>
                </div>
                <div className="card">
                  <div className="metric-label">Typical ingestion rate</div>
                  <div style={{ fontSize: 13 }}>{p.typicalIngestionRate}</div>
                </div>
                <div className="card">
                  <div className="metric-label">Typical vector volume</div>
                  <div style={{ fontSize: 13 }}>{p.typicalVectorVolume}</div>
                </div>
                <div className="card">
                  <div className="metric-label">Typical query profile</div>
                  <div style={{ fontSize: 13 }}>{p.typicalQueryProfile}</div>
                </div>
                <div className="card">
                  <div className="metric-label">Typical latency requirements</div>
                  <div style={{ fontSize: 13 }}>{p.typicalLatencyRequirements}</div>
                </div>
                <div className="card">
                  <div className="metric-label">Typical retrieval method</div>
                  <div style={{ fontSize: 13 }}>{p.typicalRetrievalMethod}</div>
                </div>
              </div>

              {list('Security / compliance considerations', p.securityComplianceConsiderations)}
              {list('Recommended design considerations', p.recommendedDesignConsiderations)}
              {list('Candidate technology categories', p.candidateTechnologyCategories)}
              {list('Validation requirements', p.validationRequirements)}
              {tokenProfile(p)}
              {infrastructureFitment(p, openGuide)}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
