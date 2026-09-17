import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, DashboardSummary } from '../api/client';
import { TopBar } from '../components/TopBar';

function metric(label: string, value: string | number | null, unit = '') {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      {value === null ? (
        <div className="metric-value placeholder">Pending assessment</div>
      ) : (
        <div className="metric-value">
          {value}
          {unit}
        </div>
      )}
    </div>
  );
}

export function DashboardPage() {
  const [summaries, setSummaries] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<DashboardSummary[]>('/dashboard/summary')
      .then((res) => setSummaries(res.data))
      .catch(() => setError('Could not load dashboard summary.'));
  }, []);

  return (
    <div className="main-content">
      <TopBar title="Dashboard" />

      <div style={{ marginBottom: 20 }}>
        <Link to="/projects/new" className="primary-btn" style={{ display: 'inline-block', textDecoration: 'none' }}>
          + New Project
        </Link>
      </div>

      {error && <p className="error-text">{error}</p>}

      {summaries?.length === 0 && (
        <div className="card">No projects yet. Create one to start the Phase 1 Discovery assessment.</div>
      )}

      {summaries?.map((s) => (
        <div key={s.projectId} style={{ marginBottom: 28 }}>
          <div className="top-bar">
            <h3 style={{ margin: 0 }}>
              <Link to={`/projects/${s.projectId}/discovery`}>{s.projectName}</Link>
            </h3>
            <span className="status-pill">{s.assessmentStatus.replace('_', ' ')}</span>
          </div>
          <div className="card-grid">
            {metric('Recommended Platform', s.recommendedPlatform === 'undetermined' ? null : s.recommendedPlatform)}
            {metric('Vector Count', s.vectorCount)}
            {metric('Dataset Size', s.datasetSizeBytes ? `${(s.datasetSizeBytes / 1024 ** 3).toFixed(2)} GB` : null)}
            {metric('Target QPS', s.targetQps)}
            {metric('Target P95 Latency', s.targetP95LatencyMs, 'ms')}
            {metric('Measured P95 Latency', s.measuredP95LatencyMs, 'ms')}
            {metric('Target Recall@K', s.targetRecallAtK)}
            {metric('Capacity Utilization', s.capacityUtilizationPercent, '%')}
          </div>
          {s.risks.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="metric-label">Risks</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {s.risks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {s.recommendations.length > 0 && (
            <div className="card">
              <div className="metric-label">Recommendations</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {s.recommendations.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
