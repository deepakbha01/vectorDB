import { useEffect, useState } from 'react';
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
        </div>
      ))}
    </div>
  );
}
