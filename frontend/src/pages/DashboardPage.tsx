import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, DashboardSummary, extractErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
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
  const { user } = useAuth();
  const canDelete = user?.role === 'admin' || user?.role === 'architect';
  const [summaries, setSummaries] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startDelete = (projectId: string) => {
    setConfirming(projectId);
    setTyped('');
    setDeleteError(null);
    setNotice(null);
  };

  const confirmDelete = async (s: DashboardSummary) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.delete(`/projects/${s.projectId}`);
      setSummaries((list) => list?.filter((x) => x.projectId !== s.projectId) ?? null);
      setConfirming(null);
      setNotice(`Project "${s.projectName}" was deleted.`);
    } catch (err) {
      setDeleteError(extractErrorMessage(err, 'Could not delete the project.'));
    } finally {
      setDeleting(false);
    }
  };

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
        </Link>{' '}
        <Link to="/patterns" style={{ marginLeft: 10, fontSize: 13 }}>
          Browse AI Factory Pattern Library
        </Link>
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--success)' }}>
          {notice}
        </div>
      )}

      {summaries?.length === 0 && (
        <div className="card">No projects yet. Create one to start the Phase 1 Discovery assessment.</div>
      )}

      {summaries?.map((s) => (
        <div key={s.projectId} style={{ marginBottom: 28 }}>
          <div className="top-bar">
            <h3 style={{ margin: 0 }}>
              <Link to={`/projects/${s.projectId}/discovery`}>{s.projectName}</Link>
            </h3>
            <span>
              <span className="status-pill" style={{ marginRight: 6 }}>
                {s.customerMode === 'existing' ? 'Existing / Modernization' : 'New / Greenfield'}
              </span>
              <span className="status-pill">{s.assessmentStatus.replace('_', ' ')}</span>
              {canDelete && confirming !== s.projectId && (
                <button
                  type="button"
                  onClick={() => startDelete(s.projectId)}
                  style={{ marginLeft: 10, background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 6, padding: '3px 10px', fontSize: 12 }}
                >
                  Delete
                </button>
              )}
            </span>
          </div>
          {confirming === s.projectId && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--danger)' }}>
              <strong>Delete "{s.projectName}" permanently?</strong>
              <p style={{ fontSize: 13, margin: '6px 0' }}>
                This removes the project and everything recorded for it - every phase deliverable, AI Factory assessment and token usage. It cannot be undone. The audit log
                keeps its entries, and your own vector databases are not touched.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed === s.projectName) void confirmDelete(s);
                }}
                style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
              >
                <label htmlFor={`confirm-${s.projectId}`}>Type the project name to confirm:</label>
                <input id={`confirm-${s.projectId}`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus style={{ padding: '6px 8px', minWidth: 240 }} autoComplete="off" />
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={typed !== s.projectName || deleting}
                  style={{ background: 'var(--danger-strong)', padding: '6px 12px', fontSize: 13 }}
                >
                  {deleting ? 'Deleting...' : 'Delete permanently'}
                </button>
                <button type="button" onClick={() => setConfirming(null)} disabled={deleting} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 13 }}>
                  Cancel
                </button>
              </form>
              {deleteError && <div className="error-text" style={{ marginTop: 6 }}>{deleteError}</div>}
            </div>
          )}
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
