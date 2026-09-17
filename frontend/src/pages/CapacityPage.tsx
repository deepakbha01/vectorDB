import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, CapacityPlan, CreateCapacityPlanInput, extractErrorMessage, Project } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

export function CapacityPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [plan, setPlan] = useState<CapacityPlan | null>(null);
  const [form, setForm] = useState<CreateCapacityPlanInput>({});
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient
      .get<CapacityPlan>(`/projects/${id}/capacity-planning/plans/latest`)
      .then((res) => setPlan(res.data))
      .catch(() => setPlan(null));
  }, [id]);

  const onGenerate = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setGenerating(true);
    try {
      const { data } = await apiClient.post<CapacityPlan>(`/projects/${id}/capacity-planning/plans`, form);
      setPlan(data);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not generate the capacity plan.'));
    } finally {
      setGenerating(false);
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
        <TopBar title="Phase 7 - Operations: Scaling & Sharding" />

        <form className="stacked" style={{ maxWidth: 480, marginBottom: 24 }} onSubmit={onGenerate}>
          <p style={{ fontSize: 13, color: '#5a6472' }}>
            Projects vector count, QPS, memory, storage, and CPU forward 6/12/24 months from your Phase 1 growth rate,
            and recommends scaling, sharding, HA, and DR strategy. All overrides below are optional - defaults come
            from Discovery and Index Design.
          </p>
          <div>
            <label>Monthly growth rate override (%)</label>
            <input
              type="number"
              step={0.1}
              value={form.monthlyGrowthPercent ?? ''}
              onChange={(e) => setForm({ ...form, monthlyGrowthPercent: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="primary-btn" type="submit" disabled={generating}>
            {generating ? 'Generating...' : 'Generate Capacity Plan'}
          </button>
        </form>

        {plan && (
          <div>
            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Current vectors</div>
                <div className="metric-value">{plan.currentState.vectorCount.toLocaleString()}</div>
              </div>
              <div className="card">
                <div className="metric-label">Current memory</div>
                <div className="metric-value">{plan.currentState.memoryGb.toFixed(1)} GB</div>
              </div>
              <div className="card">
                <div className="metric-label">Current storage</div>
                <div className="metric-value">{plan.currentState.storageGb.toFixed(1)} GB</div>
              </div>
              <div className="card">
                <div className="metric-label">Current CPU</div>
                <div className="metric-value">{plan.currentState.cpuCores.toFixed(1)} cores</div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
              <div className="metric-label" style={{ marginBottom: 8 }}>
                Capacity timeline
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
                    <th style={{ padding: '6px 8px' }}>Horizon</th>
                    <th style={{ padding: '6px 8px' }}>Vectors</th>
                    <th style={{ padding: '6px 8px' }}>QPS</th>
                    <th style={{ padding: '6px 8px' }}>Memory</th>
                    <th style={{ padding: '6px 8px' }}>Storage</th>
                    <th style={{ padding: '6px 8px' }}>CPU</th>
                    <th style={{ padding: '6px 8px' }}>Triggers</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.forecast.map((f) => (
                    <tr key={f.horizonMonths} style={{ borderBottom: '1px solid #eceff3' }}>
                      <td style={{ padding: '6px 8px' }}>{f.horizonMonths}mo</td>
                      <td style={{ padding: '6px 8px' }}>{f.projectedVectorCount.toLocaleString()}</td>
                      <td style={{ padding: '6px 8px' }}>{f.projectedQps}</td>
                      <td style={{ padding: '6px 8px' }}>{f.estimatedMemoryGb.toFixed(1)}GB</td>
                      <td style={{ padding: '6px 8px' }}>{f.estimatedStorageGb.toFixed(1)}GB</td>
                      <td style={{ padding: '6px 8px' }}>{f.estimatedCpuCores.toFixed(1)}</td>
                      <td style={{ padding: '6px 8px', color: f.scalingTriggersHit.length > 0 ? '#c0392b' : '#5a6472' }}>
                        {f.scalingTriggersHit.length > 0 ? `${f.scalingTriggersHit.length} trigger(s)` : 'none'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.forecast.flatMap((f) => f.scalingTriggersHit).length > 0 && (
                <ul style={{ fontSize: 12, marginTop: 10, paddingLeft: 18 }}>
                  {plan.forecast.flatMap((f) => f.scalingTriggersHit).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Sharding: {plan.shardingRecommendation.strategy}</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {plan.shardingRecommendation.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
              <div className="card">
                <div className="metric-label">High availability</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {plan.haRecommendation.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </div>
              <div className="card">
                <div className="metric-label">Disaster recovery</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {plan.drRecommendation.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="card">
              <div className="metric-label">Recommended infrastructure</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {plan.recommendedInfrastructure.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
