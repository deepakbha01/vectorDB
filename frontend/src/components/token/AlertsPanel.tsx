import { useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { AlertsResponse, TokenAlert } from '../../api/tokenObservability';
import { linkBtn, VIZ } from './charts';

/** Status colours are reserved for status and always come with an icon and a label. */
const SEVERITY: Record<TokenAlert['severity'], { icon: string; label: string; color: string }> = {
  critical: { icon: '◆', label: 'Critical', color: '#d03b3b' },
  warning: { icon: '▲', label: 'Warning', color: '#b8860b' },
};
const RULE_LABEL: Record<string, string> = {
  budget: 'Token budget',
  spike: 'Sudden spike',
  tokensPerRequest: 'Tokens per request',
  unexpectedModel: 'Unexpected model',
  agentLoops: 'Agent calls',
  ragContextGrowth: 'RAG context growth',
  costIncrease: 'Cost increase',
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** Token alerts (spec §14), evaluated on live usage. */
export function AlertsPanel({ projectId, onChanged }: { projectId: string; onChanged?: (open: number) => void }) {
  const { user } = useAuth();
  const canAct = user?.role === 'admin' || user?.role === 'architect';
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (all = showAll) => {
    try {
      const { data: d } = await apiClient.get<AlertsResponse>(`/projects/${projectId}/token-observability/alerts?status=${all ? 'all' : 'open'}`);
      setData(d);
      onChanged?.(d.alerts.filter((a) => a.status === 'open').length);
    } catch (e) {
      setError(extractErrorMessage(e, 'Could not load alerts.'));
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, showAll]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(extractErrorMessage(e, 'The action failed.'));
    } finally {
      setBusy(false);
    }
  };

  const open = data?.alerts.filter((a) => a.status === 'open') ?? [];
  const shown = showAll ? (data?.alerts ?? []) : open;

  return (
    <div className="card" style={{ maxWidth: 1250, marginTop: 16, borderLeft: `4px solid ${open.some((a) => a.severity === 'critical') ? '#d03b3b' : open.length ? '#fab219' : '#dfe3e8'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          Alerts - {open.length ? `${open.length} open` : 'none open'}
          {data && <span style={{ color: VIZ.muted }}> · live usage checked every {data.evaluateEveryMinutes} min{data.lastEvaluation ? `, last ${when(data.lastEvaluation.evaluatedAt)}` : ''}</span>}
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <button type="button" style={linkBtn} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Open only' : 'Include resolved'}
          </button>
          {canAct && (
            <button type="button" style={linkBtn} disabled={busy} onClick={() => act(() => apiClient.post(`/projects/${projectId}/token-observability/alerts/evaluate`))}>
              {busy ? 'Checking…' : 'Evaluate now'}
            </button>
          )}
        </div>
      </div>
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      {shown.length === 0 ? (
        <p style={{ fontSize: 13, color: VIZ.ink2, margin: '8px 0 0' }}>{showAll ? 'No alerts yet.' : 'Nothing needs attention.'}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {shown.map((a) => {
            const s = SEVERITY[a.severity];
            const resolved = a.status === 'resolved';
            return (
              <div key={a.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 13, opacity: resolved ? 0.65 : 1, borderTop: '1px solid #eceff3', paddingTop: 8 }}>
                <span style={{ color: resolved ? VIZ.muted : s.color, minWidth: 78, fontWeight: 600 }}>
                  {resolved ? '○ Resolved' : `${s.icon} ${s.label}`}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{a.title}</strong>
                  <span style={{ color: VIZ.muted }}> · {RULE_LABEL[a.rule] ?? a.rule}</span>
                  <div style={{ color: VIZ.ink2, marginTop: 2 }}>{a.detail}</div>
                  <div style={{ color: VIZ.muted, fontSize: 12, marginTop: 2 }}>
                    First seen {when(a.firstSeenAt)} · last seen {when(a.lastSeenAt)}
                    {resolved && ` · resolved ${when(a.resolvedAt)}`}
                    {a.acknowledgedAt && ` · acknowledged by ${a.acknowledgedBy ?? 'someone'} ${when(a.acknowledgedAt)}`}
                  </div>
                </div>
                {canAct && !resolved && !a.acknowledgedAt && (
                  <button type="button" style={{ ...linkBtn, fontSize: 12 }} disabled={busy} onClick={() => act(() => apiClient.post(`/projects/${projectId}/token-observability/alerts/${a.id}/acknowledge`))}>
                    Acknowledge
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {data?.lastEvaluation && data.lastEvaluation.silent.length > 0 && (
        <details style={{ marginTop: 8, fontSize: 12, color: VIZ.ink2 }}>
          <summary style={{ cursor: 'pointer' }}>Not checked in the last evaluation ({data.lastEvaluation.silent.length})</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {data.lastEvaluation.silent.map((s) => (
              <li key={s.rule}>
                {RULE_LABEL[s.rule] ?? s.rule}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
