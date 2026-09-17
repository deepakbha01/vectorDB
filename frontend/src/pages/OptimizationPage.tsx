import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, CreateBenchmarkInput, extractErrorMessage, OptimizationReport, Project } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

export function OptimizationPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [report, setReport] = useState<OptimizationReport | null>(null);
  const [form, setForm] = useState<CreateBenchmarkInput>({});
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient
      .get<OptimizationReport>(`/projects/${id}/optimization/benchmarks/latest`)
      .then((res) => setReport(res.data))
      .catch(() => setReport(null));
  }, [id]);

  const onRun = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setRunning(true);
    try {
      const { data } = await apiClient.post<OptimizationReport>(`/projects/${id}/optimization/benchmarks`, form);
      setReport(data);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Benchmark run failed.'));
    } finally {
      setRunning(false);
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
        <TopBar title="Phase 6 - Operations: Latency & Recall Tuning" />

        <form className="stacked" style={{ maxWidth: 480, marginBottom: 24 }} onSubmit={onRun}>
          <p style={{ fontSize: 13, color: '#5a6472' }}>
            Runs a synthetic benchmark against your Phase 3 index configuration - a corpus of random vectors at your
            embedding dimension is provisioned in an ephemeral collection, queried across several search-parameter
            values, measured, and cleaned up automatically.
          </p>
          <div>
            <label>Sample size (optional)</label>
            <input
              type="number"
              value={form.sampleSize ?? ''}
              onChange={(e) => setForm({ ...form, sampleSize: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          <div>
            <label>Query count (optional)</label>
            <input
              type="number"
              value={form.queryCount ?? ''}
              onChange={(e) => setForm({ ...form, queryCount: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="primary-btn" type="submit" disabled={running}>
            {running ? 'Running benchmark...' : 'Run Benchmark'}
          </button>
        </form>

        {report && (
          <div>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="metric-label">Recommended configuration</div>
              <div className="metric-value" style={{ fontSize: 20 }}>
                {report.recommendedVariant.searchParamName} = {report.recommendedVariant.searchParamValue}
              </div>
              <p style={{ fontSize: 13, color: '#5a6472' }}>
                P95 {report.recommendedVariant.p95LatencyMs}ms - recall {report.recommendedVariant.avgRecall} - achieved{' '}
                {report.recommendedVariant.achievedQps} QPS (single connection)
              </p>
            </div>

            <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
              <div className="metric-label" style={{ marginBottom: 8 }}>
                Latency vs Recall vs Memory vs Cost
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
                    <th style={{ padding: '6px 8px' }}>{report.variantResults[0]?.searchParamName}</th>
                    <th style={{ padding: '6px 8px' }}>P50</th>
                    <th style={{ padding: '6px 8px' }}>P95</th>
                    <th style={{ padding: '6px 8px' }}>P99</th>
                    <th style={{ padding: '6px 8px' }}>Recall</th>
                    <th style={{ padding: '6px 8px' }}>QPS</th>
                  </tr>
                </thead>
                <tbody>
                  {report.variantResults.map((v) => (
                    <tr
                      key={v.searchParamValue}
                      style={{
                        borderBottom: '1px solid #eceff3',
                        fontWeight: v.searchParamValue === report.recommendedVariant.searchParamValue ? 600 : 400,
                      }}
                    >
                      <td style={{ padding: '6px 8px' }}>
                        {v.searchParamValue} {v.isBaseline ? '(Phase 3 baseline)' : ''}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{v.p50LatencyMs}ms</td>
                      <td style={{ padding: '6px 8px' }}>{v.p95LatencyMs}ms</td>
                      <td style={{ padding: '6px 8px' }}>{v.p99LatencyMs}ms</td>
                      <td style={{ padding: '6px 8px' }}>{v.avgRecall}</td>
                      <td style={{ padding: '6px 8px' }}>{v.achievedQps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: '#5a6472', marginTop: 8 }}>
                Memory estimate: {report.capacityImpact.estimatedMemoryGb} GB - directional cost estimate: $
                {report.costImplications.estimatedCostPerHourUsd}/hour (same across variants; search-time parameters
                don't change the index's memory footprint).
              </p>
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Bottlenecks</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {report.bottlenecks.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
              <div className="card">
                <div className="metric-label">Before / after</div>
                <p style={{ fontSize: 13 }}>
                  Baseline ({report.beforeAfterComparison.baseline.searchParamValue}): P95{' '}
                  {report.beforeAfterComparison.baseline.p95LatencyMs}ms, recall {report.beforeAfterComparison.baseline.avgRecall}
                </p>
                <p style={{ fontSize: 13 }}>
                  Recommended ({report.beforeAfterComparison.recommended.searchParamValue}): P95{' '}
                  {report.beforeAfterComparison.recommended.p95LatencyMs}ms, recall{' '}
                  {report.beforeAfterComparison.recommended.avgRecall}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
