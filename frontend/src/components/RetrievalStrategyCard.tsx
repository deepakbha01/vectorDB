import { RetrievalFamily, RetrievalStrategyResult } from '../api/client';

const FAMILY: Record<RetrievalFamily, { label: string; tone: 'validated' | 'warning' | '' }> = {
  vectorless: { label: 'Vectorless - no vector database needed', tone: 'validated' },
  hybrid: { label: 'Hybrid - vector database plus full-text', tone: 'warning' },
  vector: { label: 'Vector database needed', tone: '' },
};

const LEAN_TONE = { vectorless: 'validated', vector: 'warning', neutral: '' } as const;

const cell = { padding: '6px 8px', verticalAlign: 'top' as const };

function money(n: number): string {
  if (n >= 10000) return `$${Math.round(n / 1000).toLocaleString('en-US')}K`;
  if (n >= 1) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(4)}`;
}

function tokens(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

/**
 * Phase 4 Retrieval Strategy Assessment - "does this workload need a vector
 * database at all?". Sits above the platform decision: when vectorless wins,
 * the ranked platform below is the fallback, not the plan.
 */
export function RetrievalStrategyCard({ strategy, fallbackPlatform }: { strategy: RetrievalStrategyResult; fallbackPlatform: string }) {
  const top = strategy.approaches[0];
  const family = FAMILY[strategy.recommendedFamily];
  return (
    <div className="card" style={{ marginBottom: 16 }} aria-label="Retrieval strategy assessment">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="metric-label" style={{ margin: 0 }}>Retrieval strategy - is a vector database needed?</div>
        <span className={`status-pill ${family.tone}`}>{family.label}</span>
        {strategy.closeCall && <span className="status-pill warning">Close call - decide by evaluation</span>}
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>{strategy.headline}</div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px' }}>{strategy.rationale}</p>
      {!strategy.vectorDatabaseRequired && (
        <p style={{ fontSize: 13, margin: '0 0 10px' }}>
          The platform recommendation below (<strong>{fallbackPlatform}</strong>) is the <strong>fallback</strong> if the evaluation does
          not confirm {top.label}.
        </p>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={cell}>Approach</th>
              <th style={cell}>Fit</th>
              <th style={cell}>Cost / query</th>
              <th style={cell}>Monthly run</th>
              <th style={cell}>One-time build</th>
              <th style={cell}>Latency</th>
              <th style={cell}>Feasibility</th>
            </tr>
          </thead>
          <tbody>
            {strategy.approaches.map((a, i) => (
              <tr key={a.approach} style={{ borderBottom: '1px solid var(--border)', fontWeight: i === 0 ? 600 : 400 }}>
                <td style={cell}>
                  {a.label}
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{a.family}</div>
                </td>
                <td style={{ ...cell, minWidth: 110 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ width: `${a.score}%`, height: '100%', background: i === 0 ? 'var(--cyan)' : 'var(--muted)' }} />
                    </div>
                    <span>{a.score}</span>
                  </div>
                </td>
                <td style={cell}>{money(a.costPerQueryUsd)}</td>
                <td style={cell}>{money(a.monthlyRunCostUsd)}</td>
                <td style={cell}>{a.oneTimeBuildCostUsd ? money(a.oneTimeBuildCostUsd) : '-'}</td>
                <td style={cell}>{a.estimatedLatencySeconds < 1 ? `${Math.round(a.estimatedLatencySeconds * 1000)} ms` : `${a.estimatedLatencySeconds.toFixed(1)} s`}</td>
                <td style={{ ...cell, fontWeight: 400 }}>
                  {a.feasibilityNotes.length === 0 ? (
                    <span className="status-pill validated">Feasible</span>
                  ) : (
                    <>
                      <span className="status-pill warning">Check</span>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{a.feasibilityNotes.join(' ')}</div>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 10px' }}>
        Corpus ≈ {tokens(strategy.corpusTokens)} tokens. Costs and latency are directional (list prices in thresholds.yaml), not quotes.
      </p>

      {strategy.additionalRoutes.length > 0 && (
        <p style={{ fontSize: 13, margin: '0 0 10px' }}>
          <strong>Also needed:</strong> {strategy.additionalRoutes.join(' and ')}.
        </p>
      )}

      <details style={{ marginBottom: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>How each factor leans</summary>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
          <tbody>
            {strategy.factors.map((f) => (
              <tr key={f.factor} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...cell, fontWeight: 600 }}>{f.factor}</td>
                <td style={cell}>{f.input}</td>
                <td style={cell}>
                  <span className={`status-pill ${LEAN_TONE[f.leansTo]}`}>{f.leansTo}</span>
                </td>
                <td style={{ ...cell, color: 'var(--muted)' }}>weight {f.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details style={{ marginBottom: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Reference architecture - {top.label}</summary>
        <ol style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }}>
          {strategy.referenceArchitecture.map((l) => (
            <li key={l.layer}>
              <strong>{l.layer}:</strong> {l.detail}
            </li>
          ))}
        </ol>
      </details>

      <details open>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Evaluation plan - decide on evidence</summary>
        <ol style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }}>
          {strategy.evaluationPlan.map((step) => (
            <li key={step} style={{ marginBottom: 3 }}>{step}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}
