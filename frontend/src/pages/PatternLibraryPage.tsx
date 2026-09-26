import { ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, PatternCatalogEntry } from '../api/client';
import { TopBar } from '../components/TopBar';

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

export function PatternLibraryPage() {
  const [patterns, setPatterns] = useState<PatternCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<PatternCatalogEntry[]>('/projects/pattern-catalog')
      .then((res) => setPatterns(res.data))
      .catch(() => setError('Could not load the pattern library.'));
  }, []);

  return (
    <div className="main-content">
      <TopBar title="AI Factory Pattern Library" />
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 760, marginBottom: 20 }}>
        Reusable, configurable starting points for a new project. Picking a pattern on{' '}
        <Link to="/projects/new">project creation</Link> seeds Phase 1 Discovery with typical defaults for that use
        case - every value stays fully editable, and Phase 4 (Vector DB Selection) still qualifies and scores
        candidate platforms from scratch regardless of which pattern (if any) was used.
      </p>

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
        </div>
      ))}
    </div>
  );
}
