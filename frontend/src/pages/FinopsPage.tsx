import { ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { CostCategory, CostResource, FinopsAssessment, FinopsDefaults, FinopsResult } from '../api/finops';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';
import { TokenCostPanel } from '../components/token/TokenCostPanel';

const CATEGORY: Record<CostCategory, string> = { inference: 'Inference', vector_db: 'Vector database', embedding: 'Embedding', infrastructure: 'Infrastructure', operations: 'Operations' };
const RESOURCE: Record<CostResource, string> = { gpu: 'GPU', cpu: 'CPU', storage: 'Storage', network: 'Network', api: 'API spend', people: 'People / support', other: 'Other' };
const VALIDATION = {
  pass_with_conditions: { label: 'Within budget - estimates to confirm', color: '#9a6700' },
  further_assessment: { label: 'Requires further assessment', color: '#7d3cbd' },
  fail: { label: 'Over budget', color: '#b03a2e' },
} as const;
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const small = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`);
const evidence = (e: string) => e.replace('_', '-');

export function FinopsPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [defaults, setDefaults] = useState<FinopsDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [latest, setLatest] = useState<FinopsAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<FinopsDefaults>(`/projects/${id}/ai-factory/finops/defaults`)
      .then((r) => setDefaults(r.data))
      .catch((e) => setDefaultsError(extractErrorMessage(e, 'Could not load the cost inputs.')));
    apiClient
      .get<FinopsAssessment>(`/projects/${id}/ai-factory/finops/latest`)
      .then((r) => setLatest(r.data))
      .catch(() => setLatest(null));
  }, [id]);

  const run = async () => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiClient.post<FinopsAssessment>(`/projects/${id}/ai-factory/finops`);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not run the cost assessment.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Cost & FinOps" />
        {!features.aiFactory && !defaults && !defaultsError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            The AI Factory workflow is not enabled on this server (<code>AI_FACTORY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              Operating cost of the recommended architecture, built from the sizing in earlier phases (<Link to={`/projects/${project.id}/inference`}>Inference</Link>,{' '}
              <Link to={`/projects/${project.id}/vector-db-selection`}>Vector DB</Link>, <Link to={`/projects/${project.id}/data-pipeline`}>Data &amp; Embeddings</Link>,{' '}
              <Link to={`/projects/${project.id}/infrastructure-design`}>Infrastructure Design</Link>) and a directional rate card, and compared across on-premises, Azure,
              AWS, OCI, GCP and hybrid.
            </p>
            {defaultsError && <div className="card" style={{ maxWidth: 900, color: '#9a6700' }}>{defaultsError}</div>}
            {defaults && (
              <div className="card" style={{ maxWidth: 1150, borderLeft: '4px solid #9a6700', fontSize: 13 }}>
                <strong>Not a quote.</strong> {defaults.preview.disclaimer} Rate card reviewed {defaults.preview.ratesReviewed}.
              </div>
            )}
            {defaults && (
              <div style={{ marginTop: 12 }}>
                <button className="primary-btn" type="button" onClick={run} disabled={saving}>
                  {saving ? 'Pricing...' : latest ? 'Re-price (new version)' : 'Run cost assessment'}
                </button>
                {error && <div className="error-text">{error}</div>}
              </div>
            )}
            {latest && <FinopsResultView r={latest.result} version={latest.version} createdAt={latest.createdAt} />}
            {features.tokenObservability && <TokenCostPanel projectId={project.id} />}
          </>
        )}
      </div>
    </div>
  );
}

function FinopsResultView({ r, version, createdAt }: { r: FinopsResult; version: number; createdAt: string }) {
  const v = VALIDATION[r.validation.status];
  const c = r.chosen;
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderLeft: `4px solid ${v.color}` }}>
        <div className="metric-label">
          Cost &amp; FinOps Assessment · v{version} · {new Date(createdAt).toLocaleString()}
        </div>
        <div className="metric-value" style={{ fontSize: 20 }}>
          {c?.monthlyUsd ? `~${money(c.monthlyUsd)} / month (estimate)` : 'Chosen design not priced'} · <span style={{ color: v.color }}>{v.label}</span>
        </div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {c?.label ?? 'No Infrastructure Design yet'}
          {r.budget.monthlyBudgetUsd ? ` · budget ${money(r.budget.monthlyBudgetUsd)} (${r.budget.source})` : ''}
          {r.cheapestAllowed ? ` · cheapest allowed: ${r.cheapestAllowed.label} ~${money(r.cheapestAllowed.monthlyUsd)}` : ''}
        </div>
        <Bullets items={r.validation.reasons} />
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #9a6700' }}>
          <div className="metric-label">Not included yet</div>
          <Bullets items={r.gaps} />
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Compare - the same architecture on each target (monthly, estimated)</div>
        <Table
          headers={['Option', ...Object.values(CATEGORY), 'Total / month', '']}
          rows={[...(c ? [c] : []), ...r.comparison].map((o) => [
            <span key="l" style={{ fontWeight: o.id === 'chosen' ? 700 : 400 }}>
              {o.label}
              {!o.allowed && o.feasible && <div style={{ fontSize: 11, color: '#9a6700' }}>not an allowed target</div>}
            </span>,
            ...(Object.keys(CATEGORY) as CostCategory[]).map((k) => (o.byCategory ? money(o.byCategory[k]) : '—')),
            o.monthlyUsd !== null ? <strong key="t">{money(o.monthlyUsd)}</strong> : '—',
            o.feasible ? (r.cheapestAllowed?.id === o.id ? <span key="c" style={{ color: '#1e8449', fontSize: 12 }}>cheapest allowed</span> : '') : <span key="n" style={{ color: '#b03a2e', fontSize: 12 }}>{o.notFeasibleReasons.join(' ')}</span>,
          ])}
        />
      </div>

      {c?.feasible && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">Chosen design - every line and how it was derived</div>
          <Table
            headers={['Category', 'Item', 'Monthly', 'Evidence', 'Basis']}
            rows={c.lines.map((l) => [CATEGORY[l.category], l.item, money(l.monthlyUsd), evidence(l.evidenceType), <span key="b" style={{ fontSize: 12, color: '#5a6472' }}>{l.basis}</span>])}
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {r.byResource && (
          <div className="card">
            <div className="metric-label">Infrastructure view - by resource</div>
            <Table headers={['Resource', 'Monthly']} rows={(Object.keys(RESOURCE) as CostResource[]).filter((k) => r.byResource![k] > 0).map((k) => [RESOURCE[k], money(r.byResource![k])])} />
          </div>
        )}
        {r.unitEconomics.length > 0 && (
          <div className="card">
            <div className="metric-label">Unit economics (estimated)</div>
            <Table headers={['', 'USD', 'Basis']} rows={r.unitEconomics.map((u) => [u.label, small(u.usd), <span key="b" style={{ fontSize: 12, color: '#5a6472' }}>{u.basis}</span>])} />
          </div>
        )}
        {r.oneOff.length > 0 && (
          <div className="card">
            <div className="metric-label">One-off costs</div>
            <Table headers={['', 'USD', 'Evidence']} rows={r.oneOff.map((o) => [<span key="i" title={o.basis}>{o.item}</span>, money(o.usd), evidence(o.evidenceType)])} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="metric-label">What would change this</div>
        <Bullets items={r.wouldChangeIf} />
      </div>
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
