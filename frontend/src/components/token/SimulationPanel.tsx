import { FormEvent, useEffect, useRef, useState } from 'react';
import { apiClient, extractErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { SimulationRun, SimulationUploadResult } from '../../api/tokenObservability';
import { DataTable, full, linkBtn, VIZ } from './charts';
import { download } from './csv';

/** Spec §10 column names, in the order of the downloadable template (mirrors backend TEMPLATE_COLUMNS). */
const TEMPLATE_COLUMNS = [
  'event_id', 'timestamp', 'request_id', 'trace_id', 'span_id', 'parent_span_id', 'tenant_id', 'application_id', 'service_id', 'workflow_id', 'agent_id',
  'session_id', 'provider', 'model', 'model_version', 'operation_type', 'rag_stage', 'tool_name', 'environment', 'region', 'input_tokens', 'output_tokens',
  'reasoning_tokens', 'cached_input_tokens', 'total_tokens', 'embedding_tokens', 'reranking_tokens', 'context_tokens', 'retrieval_count', 'tool_call_count',
  'llm_call_count', 'latency_ms', 'ttft_ms', 'request_status', 'error_type',
];
const EXAMPLE: Record<string, string | number> = {
  event_id: 'lt-0001-llm',
  timestamp: '2026-09-25T10:00:00Z',
  request_id: 'lt-0001',
  trace_id: 'lt-0001',
  span_id: 'lt-0001-llm',
  application_id: 'claims',
  service_id: 'claims-api',
  provider: 'managed_api_tier',
  model: 'mid',
  operation_type: 'chat',
  rag_stage: 'generation',
  environment: 'loadtest',
  input_tokens: 3200,
  output_tokens: 350,
  context_tokens: 2400,
  latency_ms: 1450,
  ttft_ms: 320,
  request_status: 'success',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Simulated mode (spec §12): upload load-test or benchmark results. They are
 * stored as simulated usage only - never mixed with live telemetry - and each
 * upload can be viewed or removed as a whole.
 */
export function SimulationPanel({ projectId, onChanged, onView }: { projectId: string; onChanged: () => void; onView: (from: string, to: string) => void }) {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'architect';
  const [runs, setRuns] = useState<SimulationRun[]>([]);
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<SimulationUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    apiClient
      .get<SimulationRun[]>(`/projects/${projectId}/token-observability/simulations`)
      .then((r) => setRuns(r.data))
      .catch(() => setRuns([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return setError('Choose a CSV or JSON file first.');
    const form = new FormData();
    form.append('file', file);
    if (label.trim()) form.append('label', label.trim());
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await apiClient.post<SimulationUploadResult>(`/projects/${projectId}/token-observability/simulations`, form);
      setResult(data);
      setLabel('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
      onChanged();
    } catch (err) {
      setError(extractErrorMessage(err, 'The upload failed.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(`/projects/${projectId}/token-observability/simulations/${id}`);
      setConfirm(null);
      if (result?.id === id) setResult(null);
      await load();
      onChanged();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not delete the run.'));
    } finally {
      setBusy(false);
    }
  };

  const csvTemplate = () =>
    download('token-usage-template.csv', `${TEMPLATE_COLUMNS.join(',')}\n${TEMPLATE_COLUMNS.map((c) => EXAMPLE[c] ?? '').join(',')}\n`);
  const jsonTemplate = () => download('token-usage-template.json', `${JSON.stringify({ events: [EXAMPLE] }, null, 2)}\n`, 'application/json');

  return (
    <div className="card" style={{ maxWidth: 1250, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          Simulation runs - load-test and benchmark results ({runs.length})
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <button type="button" style={linkBtn} onClick={csvTemplate}>
            CSV template
          </button>
          <button type="button" style={linkBtn} onClick={jsonTemplate}>
            JSON example
          </button>
          <button type="button" style={linkBtn} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : canWrite ? 'Upload / manage' : 'Show runs'}
          </button>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {canWrite && (
            <form onSubmit={upload} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" aria-label="Result file" />
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Peak load test 25 Sep" maxLength={200} style={{ padding: '6px 8px', minWidth: 260 }} aria-label="Run label" />
              <button className="primary-btn" type="submit" disabled={busy} style={{ padding: '6px 12px', fontSize: 13 }}>
                {busy ? 'Uploading…' : 'Upload'}
              </button>
              <span style={{ color: VIZ.muted, fontSize: 12 }}>JSON or CSV, up to 100,000 events / 20 MB. Stored as simulated usage only; prompts and responses are refused.</span>
            </form>
          )}
          {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
          {result && (
            <div style={{ marginTop: 10, fontSize: 13, borderLeft: `4px solid ${result.rejected ? '#fab219' : '#0ca30c'}`, paddingLeft: 10 }}>
              <strong>{result.label}</strong>: {full(result.accepted)} of {full(result.received)} events stored
              {result.duplicates ? `, ${full(result.duplicates)} already present (ignored)` : ''}
              {result.rejected ? `, ${full(result.rejected)} rejected` : ''}
              {result.unpriced ? `, ${full(result.unpriced)} without a price in force` : ''}.
              {result.ignoredFields.length > 0 && <div style={{ color: VIZ.ink2 }}>Ignored columns (computed by the server): {result.ignoredFields.join(', ')}.</div>}
              {result.rejections.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <DataTable headers={['Row', 'Event', 'Why it was rejected']} rows={result.rejections.slice(0, 20).map((r) => [r.row || '—', r.eventId ?? '—', r.reason])} />
                  {(result.rejections.length > 20 || result.rejectionsTruncated) && <div style={{ color: VIZ.muted, fontSize: 12 }}>Showing the first 20 of {full(result.rejected)} rejections.</div>}
                </div>
              )}
            </div>
          )}
          {runs.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <DataTable
                headers={['Run', 'Uploaded', 'Events', 'Covers', '']}
                rows={runs.map((r) => [
                  <span key="l">
                    <strong>{r.label}</strong>
                    {r.status === 'failed' && <span style={{ color: '#d03b3b', fontSize: 12 }}> ▲ failed</span>}
                    {r.status === 'in_progress' && <span style={{ color: VIZ.muted, fontSize: 12 }}> ○ uploading</span>}
                    <div style={{ fontSize: 12, color: VIZ.muted }}>{r.fileName}</div>
                    {r.status === 'failed' && r.error && <div style={{ fontSize: 12, color: VIZ.ink2 }}>{r.error} - delete this run, then upload again.</div>}
                  </span>,
                  <span key="u">
                    {when(r.createdAt)}
                    <div style={{ fontSize: 12, color: VIZ.muted }}>{r.uploadedBy ?? ''}</div>
                  </span>,
                  <span key="e">
                    {full(r.accepted)} stored
                    {(r.duplicates > 0 || r.rejected > 0) && <div style={{ fontSize: 12, color: VIZ.muted }}>{[r.duplicates && `${full(r.duplicates)} duplicate`, r.rejected && `${full(r.rejected)} rejected`].filter(Boolean).join(' · ')}</div>}
                  </span>,
                  `${when(r.firstEventAt)} – ${when(r.lastEventAt)}`,
                  <span key="a" style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                    {r.firstEventAt && r.lastEventAt && (
                      <button type="button" style={linkBtn} onClick={() => onView(r.firstEventAt!, new Date(new Date(r.lastEventAt!).getTime() + 1000).toISOString())}>
                        View
                      </button>
                    )}
                    {canWrite &&
                      (confirm === r.id ? (
                        <>
                          <button type="button" style={{ ...linkBtn, color: '#d03b3b' }} disabled={busy} onClick={() => remove(r.id)}>
                            Confirm delete
                          </button>
                          <button type="button" style={linkBtn} onClick={() => setConfirm(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button type="button" style={linkBtn} onClick={() => setConfirm(r.id)}>
                          Delete
                        </button>
                      ))}
                  </span>,
                ])}
              />
              <div style={{ fontSize: 12, color: VIZ.muted, marginTop: 6 }}>View shows the run's time span; runs that overlap in time are shown together.</div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: VIZ.ink2, margin: '10px 0 0' }}>No runs uploaded yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
