import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { TokenEstimate, UsageCost } from '../../api/tokenObservability';
import { usd, VIZ } from './charts';
import { rangeFor } from './ObservedDashboard';

/**
 * Token cost, estimated vs actual (Token Observability, spec §13), shown on
 * the Cost & FinOps page. Read-only: it never changes the FinOps assessment,
 * which prices the whole architecture; this is the token-driven part.
 */
export function TokenCostPanel({ projectId }: { projectId: string }) {
  const [estimate, setEstimate] = useState<TokenEstimate | null>(null);
  const [live, setLive] = useState<UsageCost | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const { from, to } = rangeFor('30d');
    Promise.all([
      apiClient.get<TokenEstimate>(`/projects/${projectId}/token-observability/estimate/latest`).then((r) => r.data).catch(() => null),
      apiClient.get<UsageCost>(`/projects/${projectId}/token-observability/cost?mode=live&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.data).catch(() => null),
    ]).then(([e, c]) => {
      setEstimate(e);
      setLive(c);
      setLoaded(true);
    });
  }, [projectId]);

  if (!loaded) return null;
  const est = estimate?.result.cost.monthlyUsd ?? null;
  const actual = live?.forecast.monthlyRunRate ?? null;
  const delta = est && actual !== null ? Math.round(((actual - est) / est) * 1000) / 10 : null;

  return (
    <div className="card" style={{ maxWidth: 1150, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          Token cost - estimated vs actual
        </div>
        <Link to={`/projects/${projectId}/token-observability`} style={{ fontSize: 12 }}>
          Token Observability →
        </Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 8, fontSize: 13 }}>
        <div>
          <div className="metric-label">Estimated / month</div>
          <div className="metric-value" style={{ fontSize: 18 }}>{estimate ? usd(est, 0) : '—'}</div>
          <div style={{ color: VIZ.ink2, fontSize: 12 }}>{estimate ? `estimate v${estimate.version}, ${estimate.result.perRequest.totalTokens.toLocaleString()} tokens / request` : 'No token estimate saved yet'}</div>
        </div>
        <div>
          <div className="metric-label">Actual, live (30-day run rate)</div>
          <div className="metric-value" style={{ fontSize: 18 }}>{actual !== null ? usd(actual, 0) : '—'}</div>
          <div style={{ color: VIZ.ink2, fontSize: 12 }}>
            {actual === null ? 'No live telemetry - nothing measured yet' : live?.costIncomplete ? `▲ incomplete: ${live.unpricedEvents} event(s) without a price` : 'priced at the version in force when used'}
          </div>
        </div>
        <div>
          <div className="metric-label">Actual vs estimate</div>
          <div className="metric-value" style={{ fontSize: 18 }}>{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta}%`}</div>
          <div style={{ color: VIZ.ink2, fontSize: 12 }}>{delta === null ? 'needs an estimate and live usage' : Math.abs(delta) >= 50 ? '▲ far from the estimate - re-estimate or find the driver' : 'within the expected range'}</div>
        </div>
        <div>
          <div className="metric-label">Share of budget (estimate)</div>
          <div className="metric-value" style={{ fontSize: 18 }}>{estimate?.result.budget.shareOfBudget != null ? `${Math.round(estimate.result.budget.shareOfBudget * 100)}%` : '—'}</div>
          <div style={{ color: VIZ.ink2, fontSize: 12 }}>{estimate?.result.budget.monthlyBudgetUsd ? `of ${usd(estimate.result.budget.monthlyBudgetUsd, 0)} (${estimate.result.budget.source})` : 'No budget recorded'}</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: VIZ.muted, marginTop: 8 }}>Token-driven cost only. The FinOps assessment above prices the whole architecture and is not changed by this panel.</div>
    </div>
  );
}
