import { useEffect, useState } from 'react';
import { apiClient, extractErrorMessage } from '../../api/client';
import { SpanNode, UsageTrace } from '../../api/tokenObservability';
import { full, linkBtn, usd, VIZ } from './charts';

/** One request as a tree: user request → agent → LLM → tools → LLM (spec §9). */
export function TraceView({ projectId, traceId, onClose }: { projectId: string; traceId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<UsageTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTrace(null);
    setError(null);
    apiClient
      .get<UsageTrace>(`/projects/${projectId}/token-observability/traces/${encodeURIComponent(traceId)}`)
      .then((r) => setTrace(r.data))
      .catch((e) => setError(extractErrorMessage(e, 'Could not load the trace.')));
  }, [projectId, traceId]);

  return (
    <div className="card" style={{ borderLeft: `4px solid ${VIZ.series1}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          Trace <code>{traceId}</code>
        </div>
        <button type="button" onClick={onClose} style={linkBtn}>
          Close
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {trace && (
        <>
          <div style={{ fontSize: 13, margin: '6px 0 10px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>{full(trace.totals.totalTokens)} LLM tokens</span>
            <span>{trace.totals.llmCalls} LLM calls</span>
            <span>{trace.totals.toolCalls} tool calls</span>
            {trace.totals.embeddingTokens > 0 && <span>{full(trace.totals.embeddingTokens)} embedding tokens</span>}
            <span>{usd(trace.totals.costUsd)}{trace.totals.unpricedSpans ? ` (${trace.totals.unpricedSpans} span(s) unpriced)` : ''}</span>
            <span>{full(trace.totals.durationMs)} ms</span>
            {trace.totals.errors > 0 && <span style={{ color: 'var(--danger)' }}>▲ {trace.totals.errors} error(s)</span>}
          </div>
          {(trace.loop.excessiveLlmCalls || trace.loop.repeatedTools.length > 0) && (
            <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--warning)' }}>
              ▲ Possible loop:{' '}
              {[
                trace.loop.excessiveLlmCalls && `${trace.totals.llmCalls} LLM calls (limit ${trace.loop.threshold})`,
                ...trace.loop.repeatedTools.map((t) => `${t.tool} called ${t.calls} times`),
              ]
                .filter(Boolean)
                .join('; ')}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['Step', 'Model / tool', 'Input', 'Output', 'Other', 'Latency', 'Cost'].map((h) => (
                  <th key={h} style={{ padding: '6px 8px' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{trace.roots.flatMap((r) => rows(r, 0))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function rows(n: SpanNode, depth: number): JSX.Element[] {
  const other = [n.embeddingTokens && `${full(n.embeddingTokens)} embedding`, n.rerankingTokens && `${full(n.rerankingTokens)} rerank`].filter(Boolean).join(', ');
  const row = (
    <tr key={n.eventId} style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '5px 8px', paddingLeft: 8 + depth * 18 }}>
        {depth > 0 && <span style={{ color: VIZ.muted }}>└ </span>}
        {n.operationType}
        {n.ragStage && <span style={{ color: VIZ.muted }}> · {n.ragStage}</span>}
        {n.requestStatus === 'error' && <span style={{ color: 'var(--danger)' }}> ▲ {n.errorType ?? 'error'}</span>}
      </td>
      <td style={{ padding: '5px 8px' }}>{n.toolName ?? `${n.provider} / ${n.model}`}</td>
      <td style={{ padding: '5px 8px' }}>{n.inputTokens ? full(n.inputTokens) : ''}</td>
      <td style={{ padding: '5px 8px' }}>{n.outputTokens ? full(n.outputTokens) : ''}</td>
      <td style={{ padding: '5px 8px', color: VIZ.ink2 }}>{other}</td>
      <td style={{ padding: '5px 8px' }}>{n.latencyMs !== null ? `${full(n.latencyMs)} ms` : ''}</td>
      <td style={{ padding: '5px 8px' }}>{n.totalTokens + n.embeddingTokens + n.rerankingTokens === 0 ? '' : n.estimatedTotalCost !== null ? usd(n.estimatedTotalCost, 6) : <span style={{ color: 'var(--warning)' }}>unpriced</span>}</td>
    </tr>
  );
  return [row, ...n.children.flatMap((c) => rows(c, depth + 1))];
}
