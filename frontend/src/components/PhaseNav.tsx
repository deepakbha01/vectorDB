import { NavLink } from 'react-router-dom';
import { PhaseStatus, Project, ProjectPhase } from '../api/client';

const PHASES: Array<{ key: ProjectPhase; label: string; path?: (projectId: string) => string }> = [
  { key: 'discovery', label: '1. Discovery', path: (id) => `/projects/${id}/discovery` },
  { key: 'data_embeddings', label: '2. Data & Embeddings', path: (id) => `/projects/${id}/data-pipeline` },
  { key: 'index_design', label: '3. Index Design', path: (id) => `/projects/${id}/index-design` },
  { key: 'infrastructure', label: '4. Infrastructure', path: (id) => `/projects/${id}/deployment` },
  { key: 'ingestion', label: '5. Ingestion', path: (id) => `/projects/${id}/ingestion` },
  { key: 'optimization', label: '6. Optimization', path: (id) => `/projects/${id}/optimization` },
  { key: 'capacity', label: '7. Capacity', path: (id) => `/projects/${id}/capacity` },
];

export function PhaseNav({ project }: { project: Project }) {
  return (
    <>
      <ul className="phase-nav">
        {PHASES.map((phase) => {
          const status: PhaseStatus = project.phaseStatuses[phase.key];
          if (!phase.path) {
            return (
              <li key={phase.key}>
                <span style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', opacity: 0.5 }}>
                  {phase.label}
                  <span className="status-pill">Sprint TBD</span>
                </span>
              </li>
            );
          }
          return (
            <li key={phase.key}>
              <NavLink to={phase.path(project.id)} className={({ isActive }) => (isActive ? 'active' : '')}>
                {phase.label}
                <span className={`status-pill ${status === 'validated' ? 'validated' : ''}`}>{status.replace('_', ' ')}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div style={{ margin: '16px 8px 0', paddingTop: 12, borderTop: '1px solid #dfe3e8' }}>
        <div style={{ fontSize: 11, color: '#5a6472', textTransform: 'uppercase', marginBottom: 6 }}>Project tools</div>
        <ul className="phase-nav">
          <li>
            <NavLink to={`/projects/${project.id}/reports`} className={({ isActive }) => (isActive ? 'active' : '')}>
              Reports
            </NavLink>
          </li>
          <li>
            <NavLink to={`/projects/${project.id}/audit-log`} className={({ isActive }) => (isActive ? 'active' : '')}>
              Audit Log
            </NavLink>
          </li>
        </ul>
      </div>
    </>
  );
}
