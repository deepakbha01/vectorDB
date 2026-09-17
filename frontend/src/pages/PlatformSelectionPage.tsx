import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, PlatformCatalogEntry, Project } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

export function PlatformSelectionPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [catalog, setCatalog] = useState<PlatformCatalogEntry[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    apiClient.get<Project>(`/projects/${id}`).then((res) => {
      setProject(res.data);
      setSelected(res.data.platform === 'undetermined' ? '' : res.data.platform);
    });
    apiClient.get<PlatformCatalogEntry[]>('/projects/platform-catalog').then((res) => setCatalog(res.data));
  };

  useEffect(load, [id]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !selected) return;
    setError(null);
    setSaving(true);
    try {
      const { data } = await apiClient.patch<Project>(`/projects/${id}/platform`, {
        platform: selected,
        rationale,
      });
      setProject(data);
      setRationale('');
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not save platform selection.'));
    } finally {
      setSaving(false);
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
        <TopBar title="Phase 1 - Discovery & Platform Selection" />

        <div className="card" style={{ marginBottom: 20 }}>
          <strong>Automated recommendation engine:</strong> the Phase 1 Architecture
          Decision Engine (scoring vector count, QPS, latency, recall, existing
          platforms, and operational complexity) lands in Sprint 2. Until then, select
          a target platform manually below - your rationale is recorded for
          auditability and can be revisited once the assessment engine is available.
        </div>

        <div className="platform-options">
          {catalog.map((p) => (
            <label
              key={p.id}
              className={`platform-option ${selected === p.id ? 'selected' : ''}`}
              style={{ display: 'block' }}
            >
              <input
                type="radio"
                name="platform"
                value={p.id}
                checked={selected === p.id}
                onChange={() => setSelected(p.id)}
                style={{ marginRight: 8 }}
              />
              <strong>{p.label}</strong>
              <div style={{ fontSize: 12, color: '#5a6472' }}>
                Operational complexity: {p.operationalComplexity}
                {p.requiresKubernetes ? ' - requires Kubernetes' : ''}
              </div>
            </label>
          ))}
        </div>

        <form className="stacked" onSubmit={onSubmit}>
          <div>
            <label>Rationale (required)</label>
            <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} required />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="primary-btn" type="submit" disabled={saving || !selected}>
            {saving ? 'Saving...' : 'Save Platform Selection'}
          </button>
        </form>

        {project.platform !== 'undetermined' && (
          <div className="card" style={{ marginTop: 20 }}>
            <div className="metric-label">Current selection</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {project.platform} {project.platformIsManualOverride ? '(manual override)' : ''}
            </div>
            {project.platformDecisionRationale && (
              <p style={{ fontSize: 13, color: '#5a6472' }}>{project.platformDecisionRationale}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
