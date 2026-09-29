import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  apiClient,
  DataPipelineDesign,
  DeadLetterRecord,
  DocumentInput,
  extractErrorMessage,
  IngestionRun,
  MetadataField,
  Project,
  RetryDeadLettersResult,
} from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const SAMPLE_TEXTS = [
  'Vector databases store high-dimensional embeddings for similarity search.',
  'HNSW graphs trade memory for low-latency, high-recall approximate search.',
];

/** An example value of a metadata field's type, for the i-th sample document. */
function sampleValue(field: MetadataField, i: number): unknown {
  switch (field.type) {
    case 'number':
      return i + 1;
    case 'boolean':
      return i === 0;
    case 'date':
      return `2026-01-0${i + 1}`;
    case 'json':
      return { section: i + 1 };
    default:
      return `${field.name}-${i + 1}`;
  }
}

/**
 * Sample documents that pass the Validate stage: their metadata uses exactly the fields declared in
 * the project's Phase 2 design, so a run with the samples never fails on an undeclared field.
 */
function sampleDocuments(fields: MetadataField[]): string {
  return JSON.stringify(
    SAMPLE_TEXTS.map((text, i) => ({
      id: `doc-${i + 1}`,
      text,
      metadata: Object.fromEntries(fields.map((f) => [f.name, sampleValue(f, i)])),
    })),
    null,
    2,
  );
}

function statusPillClass(status: IngestionRun['status']) {
  if (status === 'completed') return 'status-pill validated';
  if (status === 'completed_with_errors') return 'status-pill';
  return 'status-pill';
}

export function IngestionPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [documentsJson, setDocumentsJson] = useState('');
  const [metadataFields, setMetadataFields] = useState<MetadataField[] | null>(null);
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
    apiClient
      .get<DataPipelineDesign>(`/projects/${id}/data-pipeline/designs/latest`)
      .then((res) => res.data.metadataFields ?? [])
      .catch(() => []) // no Phase 2 design yet: the run itself reports that
      .then((fields) => {
        setMetadataFields(fields);
        setDocumentsJson((current) => current || sampleDocuments(fields));
      });
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
        <TopBar eyebrow="Phase 6 · Ingestion" title="Ingestion Pipeline" />

        <form className="stacked" style={{ maxWidth: 640, marginBottom: 24 }} onSubmit={onSubmit}>
          <div>
            <label>Documents (JSON array of {'{ id?, text, metadata }'})</label>
            <textarea rows={10} style={{ fontFamily: 'monospace', fontSize: 12 }} value={documentsJson} onChange={(e) => setDocumentsJson(e.target.value)} />
            {metadataFields && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {metadataFields.length > 0
                  ? `Allowed metadata fields (Phase 2 schema): ${metadataFields.map((f) => `${f.name} (${f.type})`).join(', ')}. A document with any other field is rejected.`
                  : 'The Phase 2 schema declares no metadata fields, so documents must have empty metadata.'}
              </div>
            )}
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
                <div className="metric-label">Documents rejected</div>
                <div className="metric-value">
                  {run.metrics.documentsCorrupted} / {run.metrics.documentsSubmitted}
                </div>
              </div>
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
            {/* Documents rejected at validation are dead letters too, so a run that failed on them still shows why. */}
            {run.metrics.chunksDeadLettered + run.metrics.documentsCorrupted > 0 && (
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
                      {dl.chunkIndex != null ? ` (chunk ${dl.chunkIndex})` : ''}: {dl.reason}
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
