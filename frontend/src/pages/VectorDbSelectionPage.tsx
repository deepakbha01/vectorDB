import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  apiClient,
  ArchitectureDecisionRecord,
  AssumptionEntry,
  extractErrorMessage,
  PlainLanguageSummary,
  PlatformCatalogEntry,
  Project,
  RiskEntry,
  RiskSeverity,
  SensitivityAnalysis,
  VectorDbSelectionOutcome,
} from '../api/client';
import { ExecutiveSummaryCard } from '../components/ExecutiveSummaryCard';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const VERDICT_TONE: Record<PlainLanguageSummary['verdict'], 'validated' | 'warning' | 'danger'> = {
  'Excellent Fit': 'validated',
  'Good Fit': 'validated',
  'Workable Fit': 'warning',
  'Weak Fit': 'danger',
};

const SEVERITY_TONE: Record<RiskSeverity, 'validated' | 'warning' | 'danger'> = {
  low: 'validated',
  medium: 'warning',
  high: 'danger',
};

const RISK_STATUS_TONE: Record<RiskEntry['status'], 'validated' | 'warning' | 'danger'> = {
  open: 'danger',
  mitigated: 'warning',
  accepted: 'warning',
  closed: 'validated',
};

function RiskCard({ risk }: { risk: RiskEntry }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        <span className={`status-pill ${RISK_STATUS_TONE[risk.status]}`}>{risk.status}</span>
        <span className={`status-pill ${SEVERITY_TONE[risk.impact]}`}>impact: {risk.impact}</span>
        <span className="status-pill">likelihood: {risk.likelihood}</span>
        <span className="status-pill">{risk.category.replace(/_/g, ' ')}</span>
        {risk.validationRequired && <span className="status-pill warning">needs validation</span>}
      </div>
      <div style={{ fontSize: 13 }}>{risk.description}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Mitigation: {risk.mitigation}</div>
    </div>
  );
}

function AssumptionCard({ assumption }: { assumption: AssumptionEntry }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        <span className="status-pill">{assumption.type.replace(/_/g, ' ')}</span>
        <span className={`status-pill ${assumption.confidence === 'high' ? 'validated' : assumption.confidence === 'medium' ? 'warning' : 'danger'}`}>
          confidence: {assumption.confidence}
        </span>
        {assumption.validationRequired && <span className="status-pill warning">needs validation</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {assumption.parameter}: {assumption.value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Source: {assumption.source}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{assumption.impact}</div>
    </div>
  );
}

function PlainLanguageCard({ summary }: { summary: PlainLanguageSummary }) {
  const badgeText = summary.conditionalBadge ?? summary.verdict;
  const badgeTone = summary.conditionalBadge ? (summary.conditionalBadge.includes('Tied') ? 'warning' : 'warning') : VERDICT_TONE[summary.verdict];
  return (
    <ExecutiveSummaryCard
      badge={{ text: badgeText, tone: badgeTone }}
      headline={summary.headline}
      scorecard={summary.scorecard}
      note={{ label: 'Cost & Operational Effort', value: summary.costAndEffort }}
      considerations={summary.risks}
      bottomLine={summary.bottomLine}
    />
  );
}

const DECISION_STATUS_LABEL: Record<ArchitectureDecisionRecord['decisionStatus'], string> = {
  single: 'Single recommendation',
  tied: 'Tied - not an unambiguous winner',
  conditional: 'Conditional recommendation',
};

function DecisionStatusCard({ adr }: { adr: ArchitectureDecisionRecord }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Decision status</div>
          <div className="metric-value" style={{ fontSize: 18 }}>{DECISION_STATUS_LABEL[adr.decisionStatus]}</div>
          {adr.decisionStatus === 'tied' && (
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              Tied with: {adr.tiedPlatformIds.join(', ')}
              {adr.tieBreakStage ? ` — ${adr.tieBreakStage}` : ''}
            </p>
          )}
        </div>
        <div className="card">
          <div className="metric-label">Confidence</div>
          <div className="metric-value" style={{ fontSize: 18, textTransform: 'capitalize' }}>{adr.confidence}</div>
        </div>
      </div>
      {adr.openValidations.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="metric-label">Open before final selection</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {adr.openValidations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BudgetAndComplianceCard({ adr }: { adr: ArchitectureDecisionRecord }) {
  if (!adr.budgetFeasibility && (!adr.complianceGate || !adr.complianceGate.applicable)) {
    return null;
  }
  return (
    <div className="card-grid" style={{ marginBottom: 16 }}>
      {adr.budgetFeasibility && (
        <div className="card">
          <div className="metric-label">Budget feasibility</div>
          <div className="metric-value" style={{ fontSize: 16 }}>${adr.budgetFeasibility.monthlyBudgetUsd}/mo stated</div>
          <span className="status-pill">{adr.budgetFeasibility.status.replace(/_/g, ' ')}</span>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>{adr.budgetFeasibility.note}</p>
        </div>
      )}
      {adr.complianceGate && adr.complianceGate.applicable && (
        <div className="card">
          <div className="metric-label">PII compliance gate</div>
          <span className="status-pill">{adr.complianceGate.status}</span>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {adr.complianceGate.checks.map((c) => (
              <li key={c.control} style={{ color: c.satisfied ? 'inherit' : 'var(--danger)' }}>
                {c.control}: {c.satisfied ? 'captured' : 'not captured'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WhatIfAnalysisCard({ projectId }: { projectId: string }) {
  const [analysis, setAnalysis] = useState<SensitivityAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get<SensitivityAnalysis>(`/projects/${projectId}/vector-db-selection/latest/sensitivity-analysis`);
      setAnalysis(data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not run sensitivity analysis.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="metric-label" style={{ marginBottom: 6 }}>What-if analysis</div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
        Re-runs the current assessment under a few common what-if scenarios (QPS x2, vector count x2, budget halved, multi-region
        toggled, a stricter recall target) without submitting a new version, so you can see whether the decision is sensitive to
        these inputs before committing to it.
      </p>
      <button type="button" className="primary-btn" onClick={run} disabled={loading}>
        {loading ? 'Running...' : 'Run what-if analysis'}
      </button>
      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
      {analysis && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '6px 8px' }}>Scenario</th>
              <th style={{ padding: '6px 8px' }}>Decision</th>
              <th style={{ padding: '6px 8px' }}>Changed?</th>
              <th style={{ padding: '6px 8px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)' }}>
              <td style={{ padding: '6px 8px' }}>Baseline (current assessment)</td>
              <td style={{ padding: '6px 8px' }}>{analysis.baselineDecision}</td>
              <td style={{ padding: '6px 8px' }}>-</td>
              <td style={{ padding: '6px 8px' }}>{analysis.baselineDecisionStatus}</td>
            </tr>
            {analysis.scenarios.map((s) => (
              <tr key={s.scenario} style={{ borderBottom: '1px solid var(--border)', fontWeight: s.decisionChanged ? 600 : 400 }}>
                <td style={{ padding: '6px 8px' }}>{s.scenario}</td>
                <td style={{ padding: '6px 8px' }}>{s.decision}</td>
                <td style={{ padding: '6px 8px' }}>{s.decisionChanged ? 'Yes' : 'No'}</td>
                <td style={{ padding: '6px 8px' }}>{s.decisionStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdrView({ adr, projectId }: { adr: ArchitectureDecisionRecord; projectId: string }) {
  const [showTechnical, setShowTechnical] = useState(!adr.plainLanguageSummary);
  return (
    <div>
      {adr.plainLanguageSummary ? (
        <PlainLanguageCard summary={adr.plainLanguageSummary} />
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            This assessment was run before the plain-English summary existed. Re-run the assessment to get one.
          </p>
        </div>
      )}

      {adr.decisionStatus !== undefined && <DecisionStatusCard adr={adr} />}
      <BudgetAndComplianceCard adr={adr} />
      <WhatIfAnalysisCard projectId={projectId} />

      <button
        type="button"
        className="primary-btn"
        style={{ marginBottom: 16, background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)' }}
        onClick={() => setShowTechnical((v) => !v)}
      >
        {showTechnical ? 'Hide technical details' : 'Show technical details'}
      </button>

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label">Decision (rules v{adr.rulesVersion})</div>
        <div className="metric-value" style={{ fontSize: 22, textTransform: 'uppercase' }}>
          {adr.decision}
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>{adr.rationale}</p>
        <span className="status-pill">Operational complexity: {adr.operationalComplexity}</span>
      </div>
      )}

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
        <div className="metric-label" style={{ marginBottom: 6 }}>
          Scored options
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
          Each candidate is scored 0-1 on seven weighted criteria
          {adr.criteriaWeights
            ? ` (vector volume ${(adr.criteriaWeights.vectorCount * 100).toFixed(0)}%, query throughput ${(adr.criteriaWeights.qps * 100).toFixed(0)}%, latency ${(adr.criteriaWeights.latency * 100).toFixed(0)}%, recall ${(adr.criteriaWeights.recall * 100).toFixed(0)}%, existing-platform fit ${(adr.criteriaWeights.existingPlatform * 100).toFixed(0)}%, operational simplicity ${(adr.criteriaWeights.operationalComplexity * 100).toFixed(0)}%, cost ${(adr.criteriaWeights.cost * 100).toFixed(0)}%)`
            : ''}{' '}
          using the thresholds and weights in rules v{adr.rulesVersion}. A platform that fails a required search capability is
          "Ineligible" and cannot win regardless of score; one with an unmodeled requirement (e.g. multi-region) is "Unverified" -
          still winnable, but the decision is then marked conditional. Among eligible/unverified candidates, the highest total
          wins, with ties broken by a deterministic chain (see Decision status above).
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '6px 8px' }}>Platform</th>
              <th style={{ padding: '6px 8px' }}>Eligibility</th>
              <th style={{ padding: '6px 8px' }}>Total</th>
              <th style={{ padding: '6px 8px' }}>Vector Count</th>
              <th style={{ padding: '6px 8px' }}>QPS</th>
              <th style={{ padding: '6px 8px' }}>Latency</th>
              <th style={{ padding: '6px 8px' }}>Recall</th>
              <th style={{ padding: '6px 8px' }}>Existing</th>
              <th style={{ padding: '6px 8px' }}>Simplicity</th>
              <th style={{ padding: '6px 8px' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {adr.options
              .filter((o) => o.eligibilityStatus !== 'ineligible')
              .map((o) => (
                <tr key={o.platformId} style={{ borderBottom: '1px solid var(--border)', fontWeight: o.platformId === adr.decision ? 600 : 400 }}>
                  <td style={{ padding: '6px 8px' }}>{o.label}</td>
                  <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>{o.eligibilityStatus}</td>
                  <td style={{ padding: '6px 8px' }}>{o.totalScore.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.vectorCount.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.qps.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.latency.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.recall.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.existingPlatform.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.operationalComplexity.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{o.criteriaScores.cost.toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>

        {adr.options.some((o) => o.eligibilityStatus === 'ineligible') && (
          <div style={{ marginTop: 14 }}>
            <div className="metric-label" style={{ marginBottom: 6 }}>
              Ineligible (cannot win regardless of score)
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '6px 8px' }}>Platform</th>
                  <th style={{ padding: '6px 8px' }}>Total</th>
                  <th style={{ padding: '6px 8px' }}>Why ineligible</th>
                </tr>
              </thead>
              <tbody>
                {adr.options
                  .filter((o) => o.eligibilityStatus === 'ineligible')
                  .map((o) => (
                    <tr key={o.platformId} style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)' }}>
                      <td style={{ padding: '6px 8px' }}>{o.label}</td>
                      <td style={{ padding: '6px 8px' }}>{o.totalScore.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px' }}>{o.eligibilityNotes.join(' ')}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          {adr.options.map((o) => (
            <details key={o.platformId} style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Why {o.label} scored this way
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--muted)' }}>
                {o.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </div>
      )}

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-grid" style={{ marginBottom: 14 }}>
          <div className="card">
            <div className="metric-label">Raw Vector Data</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedRawVectorGb} GiB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated Memory</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedMemoryGb} GiB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated Storage</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedStorageGb} GiB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated CPU Cores</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedCpuCores}</div>
          </div>
        </div>
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>How these figures are calculated</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--muted)' }}>
            {adr.infrastructureEstimate.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      </div>
      )}

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label" style={{ marginBottom: 6 }}>Alternatives</div>
        {(
          [
            { bucket: 'tied' as const, title: 'Tied with the decision' },
            { bucket: 'strong' as const, title: 'Strong alternatives' },
            { bucket: 'lower_fit' as const, title: 'Lower fit for this workload' },
            { bucket: 'capacity_constraint' as const, title: 'Capacity/capability constraint' },
          ]
        )
          .map((group) => ({ ...group, items: adr.rejectedAlternatives.filter((r) => r.bucket === group.bucket) }))
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <div key={group.bucket} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{group.title}</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {group.items.map((r) => (
                  <li key={r.platformId}>{r.reason}</li>
                ))}
              </ul>
            </div>
          ))}
      </div>
      )}

      {showTechnical && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, marginBottom: 24 }}>
        <div className="card">
          <div className="metric-label">Risk Register</div>
          <div>
            {adr.risks.map((r) => (
              <RiskCard key={r.id} risk={r} />
            ))}
          </div>
        </div>
        <div className="card">
          <div className="metric-label">Assumption Register</div>
          <div>
            {adr.assumptions.map((a) => (
              <AssumptionCard key={a.id} assumption={a} />
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

export function VectorDbSelectionPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [catalog, setCatalog] = useState<PlatformCatalogEntry[]>([]);
  const [outcome, setOutcome] = useState<VectorDbSelectionOutcome | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [selected, setSelected] = useState('');
  const [rationale, setRationale] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    apiClient.get<Project>(`/projects/${id}`).then((res) => {
      setProject(res.data);
      setSelected(res.data.platform === 'undetermined' ? '' : res.data.platform);
    });
    apiClient.get<PlatformCatalogEntry[]>('/projects/platform-catalog').then((res) => setCatalog(res.data));
    apiClient
      .get<VectorDbSelectionOutcome>(`/projects/${id}/vector-db-selection/latest`)
      .then((res) => setOutcome(res.data))
      .catch(() => setOutcome(null))
      .finally(() => setLoaded(true));
  };

  useEffect(load, [id]);

  const runSelection = async () => {
    if (!id) return;
    setRunError(null);
    setRunning(true);
    try {
      const { data } = await apiClient.post<VectorDbSelectionOutcome>(`/projects/${id}/vector-db-selection/run`);
      setOutcome(data);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setRunError(extractErrorMessage(err, 'Could not run Vector DB Selection.'));
    } finally {
      setRunning(false);
    }
  };

  const onOverrideSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !selected) return;
    setOverrideError(null);
    setSaving(true);
    try {
      const { data } = await apiClient.patch<Project>(`/projects/${id}/platform`, { platform: selected, rationale });
      setProject(data);
      setRationale('');
      setShowOverride(false);
    } catch (err: any) {
      setOverrideError(extractErrorMessage(err, 'Could not save platform selection.'));
    } finally {
      setSaving(false);
    }
  };

  if (!project || !loaded) {
    return <div className="main-content">Loading...</div>;
  }

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Phase 4 - Vector DB Selection & Target Architecture" />

        {!outcome && (
          <div className="card" style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              Runs the Recommendation Engine against your latest Discovery assessment, Data & Embedding Design, and
              Index Design to qualify and score candidate platforms. Requires Phases 1-3 to be complete.
            </p>
            <button className="primary-btn" onClick={runSelection} disabled={running}>
              {running ? 'Running...' : 'Run Vector DB Selection'}
            </button>
            {runError && <div className="error-text">{runError}</div>}
          </div>
        )}

        {outcome && (
          <>
            <div style={{ marginBottom: 20 }}>
              <button className="primary-btn" onClick={runSelection} disabled={running}>
                {running ? 'Running...' : 'Re-run Vector DB Selection'}
              </button>{' '}
              <button
                type="button"
                className="primary-btn"
                style={{ background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)', marginLeft: 10 }}
                onClick={() => setShowOverride((v) => !v)}
              >
                {showOverride ? 'Hide manual override' : 'Manually override this decision'}
              </button>
              {runError && <div className="error-text">{runError}</div>}
            </div>
            <AdrView adr={outcome.adr} projectId={project.id} />
          </>
        )}

        {showOverride && (
          <div className="card" style={{ marginTop: 20 }}>
            <div className="metric-label" style={{ marginBottom: 10 }}>Manual override</div>
            <div className="platform-options">
              {catalog.map((p) => (
                <label key={p.id} className={`platform-option ${selected === p.id ? 'selected' : ''}`} style={{ display: 'block' }}>
                  <input
                    type="radio"
                    name="platform"
                    value={p.id}
                    checked={selected === p.id}
                    onChange={() => setSelected(p.id)}
                    style={{ marginRight: 8 }}
                  />
                  <strong>{p.label}</strong>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Operational complexity: {p.operationalComplexity}
                    {p.requiresKubernetes ? ' - requires Kubernetes' : ''}
                  </div>
                </label>
              ))}
            </div>
            <form className="stacked" onSubmit={onOverrideSubmit}>
              <div>
                <label>Rationale (required)</label>
                <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} required />
              </div>
              {overrideError && <div className="error-text">{overrideError}</div>}
              <button className="primary-btn" type="submit" disabled={saving || !selected}>
                {saving ? 'Saving...' : 'Save Manual Override'}
              </button>
            </form>
          </div>
        )}

        {project.platform !== 'undetermined' && (
          <div className="card" style={{ marginTop: 20 }}>
            <div className="metric-label">Current selection</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {project.platform} {project.platformIsManualOverride ? '(manual override)' : ''}
            </div>
            {project.platformDecisionRationale && (
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>{project.platformDecisionRationale}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
