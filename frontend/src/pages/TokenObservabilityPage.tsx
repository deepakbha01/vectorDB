import { ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { EvidenceType } from '../api/aiFactory';
import { TokenEstimate, TokenEstimatePreview, TokenEstimateResult } from '../api/tokenObservability';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const EVIDENCE: Record<EvidenceType, { label: string; color: string }> = {
  estimated: { label: 'Estimated', color: '#2f6fde' },
  assumption: { label: 'Assumption', color: '#9a6700' },
  measured: { label: 'Measured', color: '#1e8449' },
  vendor_listed: { label: 'Vendor-listed', color: '#5a6472' },
};
const evidence = (e: EvidenceType) => <span style={{ color: EVIDENCE[e].color, fontSize: 12 }}>{EVIDENCE[e].label}</span>;
const tokens = (n: number) => n.toLocaleString();
const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const money = (n: number | null) => (n === null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 0 })}`);

/**
 * Token Observability (AI Factory Wave 12). Estimated mode: projected from the
 * upstream phases and the versioned price table. Observed (simulated / live)
 * usage is never mixed in and never invented.
 */
export function TokenObservabilityPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [latest, setLatest] = useState<TokenEstimate | null>(null);
  const [preview, setPreview] = useState<TokenEstimatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<TokenEstimate>(`/projects/${id}/token-observability/estimate/latest`)
      .then((r) => setLatest(r.data))
      .catch(() => setLatest(null));
    apiClient
      .get<TokenEstimatePreview>(`/projects/${id}/token-observability/estimate/preview`)
      .then((r) => setPreview(r.data))
      .catch((e) => setPreviewError(extractErrorMessage(e, 'Could not build the token estimate.')));
  }, [id]);

  const save = async () => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiClient.post<TokenEstimate>(`/projects/${id}/token-observability/estimate`);
      setLatest(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save the token estimate.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const shown = latest ? { r: latest.result, title: `Saved estimate v${latest.version} · ${new Date(latest.createdAt).toLocaleString()}`, sources: latest.sources } : preview ? { r: preview.result, title: 'Preview - not saved yet', sources: preview.sources } : null;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Token Observability" />
        {!features.tokenObservability && !preview && !previewError ? (
          <div className="card" style={{ maxWidth: 800 }}>
            Token Observability is not enabled on this server (<code>AI_FACTORY_ENABLED</code> and <code>TOKEN_OBSERVABILITY_ENABLED</code>). The existing phases are unaffected either way.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#5a6472', marginTop: -8, maxWidth: 1000 }}>
              How many tokens this AI solution consumes, where, and what they cost - projected from <Link to={`/projects/${project.id}/inference`}>Inference</Link>,{' '}
              <Link to={`/projects/${project.id}/model-selection`}>Model Selection</Link>, <Link to={`/projects/${project.id}/rag-agent`}>RAG / Agent</Link> and{' '}
              <Link to={`/projects/${project.id}/data-pipeline`}>Data &amp; Embeddings</Link>, priced from the versioned price table.
            </p>
            <div className="card" style={{ maxWidth: 1150, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderLeft: '4px solid #2f6fde' }}>
              <span className="status-pill" style={{ background: '#eaf1fd', color: '#2f6fde' }}>
                Mode: Estimated
              </span>
              <span style={{ fontSize: 13, color: '#5a6472' }}>No live telemetry - observed usage appears only once real usage events are received. Nothing below is measured.</span>
            </div>
            {previewError && <div className="card" style={{ maxWidth: 900, color: '#9a6700', marginTop: 12 }}>{previewError}</div>}
            {preview && (
              <div style={{ marginTop: 12 }}>
                <button className="primary-btn" type="button" onClick={save} disabled={saving}>
                  {saving ? 'Saving...' : latest ? 'Re-estimate (new version)' : 'Save estimate'}
                </button>
                {error && <div className="error-text">{error}</div>}
              </div>
            )}
            {shown && <EstimateView r={shown.r} title={shown.title} sources={shown.sources} />}
          </>
        )}
      </div>
    </div>
  );
}

function EstimateView({ r, title, sources }: { r: TokenEstimateResult; title: string; sources: Record<string, { source: string; detail: string }> }) {
  const top = [...r.perRequest.input].sort((a, b) => b.tokens - a.tokens)[0];
  const cards: Array<[string, string, string?]> = [
    ['Total tokens / month', compact(r.monthly.totalTokens), 'estimated'],
    ['Input tokens / month', compact(r.monthly.inputTokens), 'estimated'],
    ['Output tokens / month', compact(r.monthly.outputTokens), 'estimated'],
    ['Requests / month', compact(r.monthly.requests), 'estimated'],
    ['Tokens / request', tokens(r.perRequest.totalTokens), `${r.perRequest.llmCalls} LLM call(s)`],
    ['Estimated cost / month', money(r.cost.monthlyUsd), r.cost.perRequestUsd !== null ? `${money(r.cost.perRequestUsd)} / request` : undefined],
    ['Top token consumer', top ? top.label.split(':')[0] : '—', top ? `${tokens(top.tokens)} tokens / request` : undefined],
    ['Growth vs baseline', '—', 'needs observed usage'],
  ];
  return (
    <div style={{ marginTop: 28, maxWidth: 1150, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="metric-label">
        {title} · {r.scope.summary}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {cards.map(([label, value, sub]) => (
          <div className="card" key={label}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 20 }}>
              {value}
            </div>
            {sub && <div style={{ fontSize: 12, color: '#5a6472' }}>{sub}</div>}
          </div>
        ))}
      </div>

      {r.gaps.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #9a6700' }}>
          <div className="metric-label">Not included yet</div>
          <Bullets items={r.gaps} />
        </div>
      )}

      {r.perRequest.input.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="metric-label">What goes into the final LLM call (per request)</div>
          <Table headers={['Part', 'Tokens', 'Evidence', 'Source']} rows={r.perRequest.input.map((l) => [l.label, tokens(l.tokens), evidence(l.evidenceType), <span key="s" style={{ fontSize: 12, color: '#5a6472' }}>{l.source}</span>])} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {r.rag && (
          <div className="card">
            <div className="metric-label">RAG token breakdown (per request)</div>
            <Table
              headers={['', 'Tokens']}
              rows={[
                ['User query', tokens(r.rag.queryTokens)],
                ['Query embedding', tokens(r.rag.queryEmbeddingTokens)],
                ['Chunks retrieved', tokens(r.rag.retrievalCount)],
                ['Retrieved context', tokens(r.rag.retrievedContextTokens)],
                ['Reranking', tokens(r.rag.rerankingTokens)],
                ['Conversation history', tokens(r.rag.historyTokens)],
                ['System prompt', tokens(r.rag.systemPromptTokens)],
                ['Final LLM input', tokens(r.rag.finalInputTokens)],
                ['LLM output', tokens(r.rag.outputTokens)],
                [<strong key="c">Context expansion ratio</strong>, <strong key="v">{r.rag.contextExpansionRatio}×</strong>],
              ]}
            />
          </div>
        )}
        {r.agent && (
          <div className="card">
            <div className="metric-label">
              Agent token breakdown - {r.agent.pattern} ({r.agent.llmCallsPerTask} LLM calls, {r.agent.toolCallsPerTask} tool calls per task)
            </div>
            <Table headers={['Step', 'Input', 'Output']} rows={r.agent.steps.map((s) => [s.step, tokens(s.inputTokens), tokens(s.outputTokens)])} />
            <div style={{ fontSize: 13, marginTop: 8 }}>
              {tokens(r.agent.tokensPerTask)} tokens per task{r.agent.costPerTaskUsd !== null ? ` · ~${money(r.agent.costPerTaskUsd)} per task` : ''}
            </div>
            <div style={{ fontSize: 12, color: '#5a6472', marginTop: 4 }}>{r.agent.loopGuard}</div>
          </div>
        )}
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">Cost - monthly, at the prices in force today</div>
        <Table
          headers={['Item', 'Tokens / month', 'Price / 1M', 'Monthly', 'Price used']}
          rows={r.cost.lines.map((l) => [l.item, compact(l.tokens), l.pricePer1M === null ? '—' : `$${l.pricePer1M}`, l.usd === null ? <span key="u" style={{ color: '#9a6700' }}>not priced</span> : money(l.usd), <span key="p" style={{ fontSize: 12, color: '#5a6472' }}>{l.price}</span>])}
        />
        <p style={{ fontSize: 13, margin: '8px 0 0' }}>
          {r.cost.note}
          {r.budget.monthlyBudgetUsd !== null && r.budget.shareOfBudget !== null && ` Uses ${Math.round(r.budget.shareOfBudget * 100)}% of the ${money(r.budget.monthlyBudgetUsd)} monthly budget (${r.budget.source}).`}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {r.assumptions.length > 0 && (
          <div className="card">
            <div className="metric-label">Assumptions and cross-checks</div>
            <Bullets items={r.assumptions} />
          </div>
        )}
        <div className="card">
          <div className="metric-label">Built from</div>
          <Table headers={['', 'Source', 'Detail']} rows={Object.entries(sources).map(([k, s]) => [k, s.source, <span key="d" style={{ fontSize: 12, color: '#5a6472' }}>{s.detail}</span>])} />
        </div>
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
