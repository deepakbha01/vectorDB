import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, Project, ReportFormat, ReportType } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const REPORT_TYPES: Array<{ type: ReportType; label: string }> = [
  { type: 'discovery', label: 'Discovery: Workload Qualification (Phase 1)' },
  { type: 'data-pipeline', label: 'Data Pipeline Design (Phase 2)' },
  { type: 'index-design', label: 'Indexing Strategy Guide (Phase 3)' },
  { type: 'vector-db-selection', label: 'Architecture Decision Record (Phase 4)' },
  { type: 'deployment-plan', label: 'Deployment Plan (Phase 5)' },
  { type: 'optimization-report', label: 'Optimization Report (Phase 7)' },
  { type: 'capacity-plan', label: 'Capacity Plan (Phase 8)' },
  { type: 'complete', label: 'Complete Assessment Report (all phases)' },
];

export function ReportsPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
  }, [id]);

  const onDownload = async (type: ReportType, format: ReportFormat) => {
    if (!id) return;
    const key = `${type}-${format}`;
    setError(null);
    setDownloading(key);
    try {
      const response = await apiClient.get(`/projects/${id}/reports/${type}`, { params: { format }, responseType: 'blob' });
      const disposition = response.headers['content-disposition'] as string | undefined;
      const filename = disposition?.match(/filename="(.+)"/)?.[1] ?? `${type}.${format}`;
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(`Could not generate this report - has that phase been completed yet? (${err.response?.status ?? 'error'})`);
    } finally {
      setDownloading(null);
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
        <TopBar title="Reports" />
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          Export any completed phase's deliverable, or the Complete Assessment Report combining every phase finished
          so far. A report can only be generated once its phase has produced at least one deliverable.
        </p>
        {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}
        <ul className="project-list">
          {REPORT_TYPES.map((r) => (
            <li key={r.type}>
              <span>{r.label}</span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="primary-btn" onClick={() => onDownload(r.type, 'pdf')} disabled={downloading === `${r.type}-pdf`}>
                  {downloading === `${r.type}-pdf` ? 'Generating...' : 'PDF'}
                </button>
                <button className="primary-btn" onClick={() => onDownload(r.type, 'docx')} disabled={downloading === `${r.type}-docx`}>
                  {downloading === `${r.type}-docx` ? 'Generating...' : 'DOCX'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
