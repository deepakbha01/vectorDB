import { Fragment, FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, CreateIndexDesignInput, extractErrorMessage, IndexDesign, Project, UpdateFrequency } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const UPDATE_FREQUENCIES: Array<{ value: UpdateFrequency; label: string }> = [
  { value: 'static', label: 'Static (load once, rarely changes)' },
  { value: 'low', label: 'Low (occasional batch updates)' },
  { value: 'moderate', label: 'Moderate (daily/hourly updates)' },
  { value: 'high', label: 'High (continuous streaming upserts)' },
];

const EMPTY_OVERRIDES: CreateIndexDesignInput = { updateFrequency: 'low' };

export function IndexDesignPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [form, setForm] = useState<CreateIndexDesignInput>(EMPTY_OVERRIDES);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [design, setDesign] = useState<IndexDesign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [expandedOption, setExpandedOption] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient
      .get<IndexDesign>(`/projects/${id}/index-design/designs/latest`)
      .then((res) => {
        setDesign(res.data);
        const { vectorCount, dimension, availableMemoryGb, qps, recallTarget, targetP95LatencyMs, topK } = res.data.inputsUsed;
        setForm({ updateFrequency: res.data.updateFrequency, vectorCount, dimension, availableMemoryGb, qps, recallTarget, targetP95LatencyMs, topK });
        setShowForm(false);
      })
      .catch(() => {
        // No design yet.
      });
  }, [id]);

  const overrideField = (key: keyof CreateIndexDesignInput, value: string) => {
    setForm({ ...form, [key]: value === '' ? undefined : Number(value) });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await apiClient.post<IndexDesign>(`/projects/${id}/index-design/designs`, form);
      setDesign(data);
      setShowForm(false);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not submit the index design.'));
    } finally {
      setSubmitting(false);
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
        <TopBar title="Phase 3 - Design: Index Selection" />

        {design && !showForm && (
          <div style={{ marginBottom: 20 }}>
            <button className="primary-btn" onClick={() => setShowForm(true)}>
              Revise Index Design (v{design.version + 1})
            </button>
          </div>
        )}

        {design && !showForm && (
          <div>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="metric-label">Recommended index (rules v{design.rulesVersion})</div>
              <div className="metric-value" style={{ fontSize: 22 }}>
                {design.label}
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>{design.rationale}</p>
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              {design.configuration.map((c) => (
                <div className="card" key={c.name}>
                  <div className="metric-label">{c.name}</div>
                  <div className="metric-value">{c.value}</div>
                  <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>{c.description}</p>
                </div>
              ))}
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Recall impact</div>
                <p style={{ fontSize: 13 }}>{design.impact.recallEstimate}</p>
              </div>
              <div className="card">
                <div className="metric-label">Latency impact</div>
                <p style={{ fontSize: 13 }}>{design.impact.latencyEstimate}</p>
              </div>
              <div className="card">
                <div className="metric-label">Estimated memory</div>
                <div className="metric-value">{design.impact.memoryEstimateGb} GB</div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="metric-label" style={{ marginBottom: 8 }}>
                How this is scored
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px' }}>
                Each candidate index earns a 0-1 score on five criteria; a weighted sum decides the winner:
              </p>
              <p
                style={{
                  fontSize: 12,
                  fontFamily: 'monospace',
                  background: 'var(--surface-2)',
                  padding: '8px 10px',
                  borderRadius: 6,
                  margin: '0 0 10px',
                  overflowX: 'auto',
                }}
              >
                Total = Recall&times;{design.criteriaWeights.recall} + Latency&times;{design.criteriaWeights.latency} + Memory&times;
                {design.criteriaWeights.memory} + Throughput&times;{design.criteriaWeights.throughput} + Update-friendliness&times;
                {design.criteriaWeights.updateFriendliness}
              </p>
              <ul style={{ fontSize: 12, color: 'var(--muted)', margin: 0, paddingLeft: 18 }}>
                <li>
                  <strong>Recall</strong> - how well the index's approximate search meets your {design.inputsUsed.recallTarget} recall
                  target.
                </li>
                <li>
                  <strong>Latency</strong> - how comfortably the index meets your {design.inputsUsed.targetP95LatencyMs}ms P95 target.
                </li>
                <li>
                  <strong>Memory</strong> - estimated footprint vs. your {design.inputsUsed.availableMemoryGb}GB budget (degrades
                  gradually past a comfortable utilization level, not a hard cutoff at the limit).
                </li>
                <li>
                  <strong>Throughput</strong> - fit for your {design.inputsUsed.qps} QPS target.
                </li>
                <li>
                  <strong>Update-friendliness</strong> - how well the index tolerates your &quot;{design.updateFrequency}&quot; update
                  pattern.
                </li>
              </ul>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>
                Click a row below to see the exact evidence behind that option's scores.
              </p>
            </div>

            <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
              <div className="metric-label" style={{ marginBottom: 10 }}>
                Scored options
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '6px 8px' }}>Index</th>
                    <th style={{ padding: '6px 8px' }}>Total</th>
                    <th style={{ padding: '6px 8px' }}>Recall</th>
                    <th style={{ padding: '6px 8px' }}>Latency</th>
                    <th style={{ padding: '6px 8px' }}>Memory</th>
                    <th style={{ padding: '6px 8px' }}>Throughput</th>
                    <th style={{ padding: '6px 8px' }}>Update</th>
                    <th style={{ padding: '6px 8px' }}>Est. Memory</th>
                  </tr>
                </thead>
                <tbody>
                  {design.options.map((o) => {
                    const isExpanded = expandedOption === o.indexType;
                    return (
                      <Fragment key={o.indexType}>
                        <tr
                          onClick={() => setExpandedOption(isExpanded ? null : o.indexType)}
                          style={{
                            borderBottom: '1px solid var(--border)',
                            fontWeight: o.indexType === design.decision ? 600 : 400,
                            cursor: 'pointer',
                            background: isExpanded ? 'var(--surface-2)' : undefined,
                          }}
                        >
                          <td style={{ padding: '6px 8px' }}>{o.label}</td>
                          <td style={{ padding: '6px 8px' }}>{o.totalScore.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px' }}>{o.criteriaScores.recall.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px' }}>{o.criteriaScores.latency.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px' }}>{o.criteriaScores.memory.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px' }}>{o.criteriaScores.throughput.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px' }}>{o.criteriaScores.updateFriendliness.toFixed(2)}</td>
                          <td style={{ padding: '6px 8px' }}>{o.estimatedMemoryGb} GB</td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={8} style={{ padding: '4px 8px 12px 24px', background: 'var(--surface-2)' }}>
                              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--muted)' }}>
                                {o.evidence.map((line, i) => (
                                  <li key={i}>{line}</li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="card-grid">
              <div className="card">
                <div className="metric-label">Alternatives</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {design.alternatives.map((a) => (
                    <li key={a.indexType}>{a.reason}</li>
                  ))}
                </ul>
              </div>
              <div className="card">
                <div className="metric-label">Scaling considerations</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {design.scalingConsiderations.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {showForm && (
          <form className="stacked" style={{ maxWidth: 560 }} onSubmit={onSubmit}>
            <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
              <legend>Update pattern</legend>
              <div>
                <label>How often will vectors be inserted/updated/deleted after the initial load?</label>
                <select value={form.updateFrequency} onChange={(e) => setForm({ ...form, updateFrequency: e.target.value as UpdateFrequency })}>
                  {UPDATE_FREQUENCIES.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                Vector count, dimension, QPS, recall target, latency target, and available memory default from your
                Phase 1 Discovery assessment (and Phase 2 embedding choice for dimension). Use the overrides below only
                to run a what-if comparison.
              </p>
              <button type="button" className="primary-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAdvanced(!showAdvanced)}>
                {showAdvanced ? 'Hide' : 'Show'} advanced overrides
              </button>
            </fieldset>

            {showAdvanced && (
              <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
                <legend>Overrides (optional)</legend>
                <div>
                  <label>Vector count</label>
                  <input type="number" value={form.vectorCount ?? ''} onChange={(e) => overrideField('vectorCount', e.target.value)} />
                </div>
                <div>
                  <label>Dimension</label>
                  <input type="number" value={form.dimension ?? ''} onChange={(e) => overrideField('dimension', e.target.value)} />
                </div>
                <div>
                  <label>Available memory (GB)</label>
                  <input
                    type="number"
                    value={form.availableMemoryGb ?? ''}
                    onChange={(e) => overrideField('availableMemoryGb', e.target.value)}
                  />
                </div>
                <div>
                  <label>QPS</label>
                  <input type="number" value={form.qps ?? ''} onChange={(e) => overrideField('qps', e.target.value)} />
                </div>
                <div>
                  <label>Recall target (0-1)</label>
                  <input
                    type="number"
                    step={0.01}
                    value={form.recallTarget ?? ''}
                    onChange={(e) => overrideField('recallTarget', e.target.value)}
                  />
                </div>
                <div>
                  <label>Target P95 latency (ms)</label>
                  <input
                    type="number"
                    value={form.targetP95LatencyMs ?? ''}
                    onChange={(e) => overrideField('targetP95LatencyMs', e.target.value)}
                  />
                </div>
                <div>
                  <label>Top-K</label>
                  <input type="number" value={form.topK ?? ''} onChange={(e) => overrideField('topK', e.target.value)} />
                </div>
              </fieldset>
            )}

            {error && <div className="error-text">{error}</div>}
            <button className="primary-btn" type="submit" disabled={submitting}>
              {submitting ? 'Scoring index options...' : 'Generate Indexing Strategy'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
