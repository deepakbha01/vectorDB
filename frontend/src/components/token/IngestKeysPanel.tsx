import { FormEvent, useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { CreatedIngestKey, IngestKey } from '../../api/tokenObservability';
import { DataTable, linkBtn, VIZ } from './charts';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 };

/**
 * Live telemetry (spec §11): project ingest keys for collectors and SDKs, and
 * how to connect them. Admins and architects only - the API enforces it too.
 */
export function IngestKeysPanel({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'architect';
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedIngestKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `${window.location.origin}/api/observability`;

  const load = () =>
    apiClient
      .get<IngestKey[]>(`/projects/${projectId}/token-observability/ingest-keys`)
      .then((r) => setKeys(r.data))
      .catch(() => setKeys([]));
  useEffect(() => {
    if (open && canManage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, canManage]);

  if (!canManage) return null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Name the key, e.g. "prod collector - eu-west".');
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiClient.post<CreatedIngestKey>(`/projects/${projectId}/token-observability/ingest-keys`, { name: name.trim() });
      setCreated(data);
      setCopied(false);
      setName('');
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not create the key.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(`/projects/${projectId}/token-observability/ingest-keys/${id}`);
      setConfirm(null);
      if (created?.id === id) setCreated(null);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not revoke the key.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 1250, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          Connect live telemetry - ingest keys{open ? '' : keys.length ? ` (${keys.filter((k) => !k.revokedAt).length} active)` : ''}
        </div>
        <button type="button" style={{ ...linkBtn, fontSize: 12 }} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Manage keys / how to connect'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <form onSubmit={create} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Key name, e.g. "prod collector - eu-west"' maxLength={100} style={{ padding: '6px 8px', minWidth: 300 }} aria-label="Key name" />
            <button className="primary-btn" type="submit" disabled={busy} style={{ padding: '6px 12px', fontSize: 13 }}>
              Create key
            </button>
            <span style={{ color: VIZ.muted, fontSize: 12 }}>A key can only write live usage to this project. It is shown once.</span>
          </form>
          {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}

          {created && (
            <div style={{ marginTop: 10, borderLeft: '4px solid #fab219', paddingLeft: 10 }}>
              <strong>Copy this key now - it cannot be shown again.</strong>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                <code style={{ ...mono, background: '#f5f6f8', padding: '6px 8px', borderRadius: 4, userSelect: 'all' }}>{created.key}</code>
                <button type="button" style={linkBtn} onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" style={linkBtn} onClick={() => setCreated(null)}>
                  Done
                </button>
              </div>
            </div>
          )}

          {keys.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <DataTable
                headers={['Name', 'Key', 'Created', 'Last used', 'Status', '']}
                rows={keys.map((k) => [
                  <strong key="n">{k.name}</strong>,
                  <code key="p" style={mono}>
                    aftk_{k.prefix}_…
                  </code>,
                  <span key="c">
                    {when(k.createdAt)}
                    <div style={{ fontSize: 12, color: VIZ.muted }}>{k.createdBy ?? ''}</div>
                  </span>,
                  when(k.lastUsedAt),
                  k.revokedAt ? <span key="s" style={{ color: VIZ.ink2 }}>○ Revoked {when(k.revokedAt)}</span> : <span key="s" style={{ color: '#0ca30c' }}>● Active</span>,
                  k.revokedAt ? (
                    ''
                  ) : confirm === k.id ? (
                    <span key="a" style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                      <button type="button" style={{ ...linkBtn, color: '#d03b3b' }} disabled={busy} onClick={() => revoke(k.id)}>
                        Confirm revoke
                      </button>
                      <button type="button" style={linkBtn} onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button key="a" type="button" style={{ ...linkBtn, fontSize: 12 }} onClick={() => setConfirm(k.id)}>
                      Revoke
                    </button>
                  ),
                ])}
              />
            </div>
          )}

          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
            <div>
              <div className="metric-label">Send usage events directly (SDK or service)</div>
              <pre style={{ ...mono, background: '#f5f6f8', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', margin: 0 }}>
                {`POST ${base}/usage-events
Authorization: Bearer <ingest key>
Content-Type: application/json

{ "events": [ { "eventId": "...", "timestamp": "...",
  "provider": "...", "model": "...", "operationType": "chat",
  "inputTokens": 1200, "outputTokens": 300, ... } ] }`}
              </pre>
              <div style={{ fontSize: 12, color: VIZ.muted, marginTop: 4 }}>Up to 1000 events per request; re-sent events are ignored. Never include prompt or response text.</div>
            </div>
            <div>
              <div className="metric-label">Or through an OpenTelemetry Collector</div>
              <pre style={{ ...mono, background: '#f5f6f8', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', margin: 0 }}>
                {`AI_FACTORY_INGEST_KEY=<ingest key> \\
  docker compose --profile telemetry up

# applications export OTLP to the collector:
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318`}
              </pre>
              <div style={{ fontSize: 12, color: VIZ.muted, marginTop: 4 }}>
                The collector (otel/collector.yaml) keeps only GenAI spans, strips message content and forwards to {base}/v1/traces as OTLP JSON. Attribute mapping: config/token-observability.yaml → otel.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
