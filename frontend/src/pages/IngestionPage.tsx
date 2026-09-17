import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, DeadLetterRecord, DocumentInput, extractErrorMessage, IngestionRun, Project, RetryDeadLettersResult } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const SAMPLE_DOCUMENTS = JSON.stringify(
  [
    { id: 'doc-1', text: 'Vector databases store high-dimensional embeddings for similarity search.', metadata: { source: 'intro.md' } },
    { id: 'doc-2', text: 'HNSW graphs trade memory for low-latency, high-recall approximate search.', metadata: { source: 'indexing.md' } },
  ],
  null,
  2,
);

function statusPillClass(status: IngestionRun['status']) {
  if (status === 'completed') return 'status-pill validated';
  if (status === 'completed_with_errors') return 'status-pill';
  return 'status-pill';
}

export function IngestionPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [documentsJson, setDocumentsJson] = useState(SAMPLE_DOCUMENTS);
  const [history, setHistory] = useState<IngestionRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetterRecord[] | null>(null);
  const [retryResult, setRetryResult] = useState<RetryDeadLettersResult | null>(null);
  const [retrying, setRetrying] = useState(false);

  const loadHistory = () => {
    if (!id) return;
    apiClient.get<IngestionRun[]>(`/projects/${id}/ingestion/runs`).then((res) => setHistory(res.data));
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    loadHistory();
  }, [id]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    let documents: DocumentInput[];
    try {
      documents = JSON.parse(documentsJson);
    } catch {
      setError('Documents must be valid JSON: an array of { id?, text, metadata } objects.');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post<IngestionRun>(`/projects/${id}/ingestion/runs`, { documents });
      loadHistory();
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Ingestion run failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const viewDeadLetters = async (runId: string) => {
    if (!id) return;
    setSelectedRunId(runId);
    setRetryResult(null);
    const { data } = await apiClient.get<DeadLetterRecord[]>(`/projects/${id}/ingestion/runs/${runId}/dead-letters`);
    setDeadLetters(data);
  };

  const onRetryDeadLetters = async (runId: string) => {
    if (!id) return;
    setRetrying(true);
    try {
      const { data } = await apiClient.post<RetryDeadLettersResult>(`/projects/${id}/ingestion/runs/${runId}/retry-dead-letters`);
      setRetryResult(data);
      await viewDeadLetters(runId);
      loadHistory();
    } finally {
      setRetrying(false);
    }
  };

  if (!project) {
    return <div className="main-content">Loading...</div>;
  }

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Phase 5 - Implementation: Ingestion Pipeline" />

        <form className="stacked" style={{ maxWidth: 640, marginBottom: 24 }} onSubmit={onSubmit}>
          <div>
            <label>Documents (JSON array of {'{ id?, text, metadata }'})</label>
            <textarea rows={10} style={{ fontFamily: 'monospace', fontSize: 12 }} value={documentsJson} onChange={(e) => setDocumentsJson(e.target.value)} />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="primary-btn" type="submit" disabled={submitting}>
            {submitting ? 'Running ingestion...' : 'Run Ingestion'}
          </button>
        </form>

        <div className="metric-label" style={{ marginBottom: 8 }}>
          Run history
        </div>
        {history.length === 0 && <div className="card">No ingestion runs yet.</div>}
        {history.map((run) => (
          <div key={run.id} style={{ marginBottom: 16 }}>
            <div className="top-bar">
              <h4 style={{ margin: 0 }}>
                v{run.version} - {run.collectionName}
              </h4>
              <span className={statusPillClass(run.status)}>{run.status.replace(/_/g, ' ')}</span>
            </div>
            <div className="card-grid" style={{ marginBottom: 8 }}>
              <div className="card">
                <div className="metric-label">Chunks produced</div>
                <div className="metric-value">{run.metrics.chunksProduced}</div>
              </div>
              <div className="card">
                <div className="metric-label">Stored</div>
                <div className="metric-value">{run.metrics.chunksStored}</div>
              </div>
              <div className="card">
                <div className="metric-label">Deduplicated</div>
                <div className="metric-value">{run.metrics.chunksDeduplicated}</div>
              </div>
              <div className="card">
                <div className="metric-label">Dead-lettered</div>
                <div className="metric-value">{run.metrics.chunksDeadLettered}</div>
              </div>
              <div className="card">
                <div className="metric-label">Duration</div>
                <div className="metric-value">{run.metrics.durationMs}ms</div>
              </div>
            </div>
            {run.metrics.chunksDeadLettered > 0 && (
              <button className="primary-btn" onClick={() => viewDeadLetters(run.id)}>
                View dead letters
              </button>
            )}

            {selectedRunId === run.id && deadLetters && (
              <div className="card" style={{ marginTop: 10 }}>
                <div className="top-bar">
                  <div className="metric-label">Dead letters ({deadLetters.length})</div>
                  <button className="primary-btn" onClick={() => onRetryDeadLetters(run.id)} disabled={retrying}>
                    {retrying ? 'Retrying...' : 'Retry Dead Letters'}
                  </button>
                </div>
                {retryResult && (
                  <p style={{ fontSize: 13 }}>
                    Reprocessed {retryResult.reprocessed}, still failed {retryResult.stillFailed}.
                  </p>
                )}
                <ul style={{ fontSize: 12, paddingLeft: 18 }}>
                  {deadLetters.map((dl) => (
                    <li key={dl.id} style={{ marginBottom: 4 }}>
                      <strong>{dl.documentId ?? 'unknown document'}</strong>
                      {dl.chunkIndex !== undefined ? ` (chunk ${dl.chunkIndex})` : ''}: {dl.reason}
                      {dl.reprocessed ? ' - reprocessed' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
