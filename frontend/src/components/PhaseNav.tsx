import { NavLink } from 'react-router-dom';
import { PhaseStatus, Project, ProjectPhase } from '../api/client';
import { useFeatures } from '../api/features';
import { PhaseKey, useLineage } from '../api/aiFactory';

const PHASES: Array<{ key: ProjectPhase; label: string; path?: (projectId: string) => string }> = [
  { key: 'discovery', label: '1. Discovery', path: (id) => `/projects/${id}/discovery` },
  { key: 'data_embeddings', label: '2. Data & Embeddings', path: (id) => `/projects/${id}/data-pipeline` },
  { key: 'index_design', label: '3. Index Design', path: (id) => `/projects/${id}/index-design` },
  { key: 'vector_db_selection', label: '4. Vector DB Selection', path: (id) => `/projects/${id}/vector-db-selection` },
  { key: 'infrastructure', label: '5. Infrastructure', path: (id) => `/projects/${id}/deployment` },
  { key: 'ingestion', label: '6. Ingestion', path: (id) => `/projects/${id}/ingestion` },
  { key: 'optimization', label: '7. Optimization', path: (id) => `/projects/${id}/optimization` },
  { key: 'capacity', label: '8. Capacity', path: (id) => `/projects/${id}/capacity` },
];

export function PhaseNav({ project }: { project: Project }) {
  // AI Factory additions render only when the flag is on; with it off this component is unchanged.
  const features = useFeatures();
  const lineage = useLineage(project.id, features.aiFactory);
  return (
    <>
      <span className="status-pill" style={{ display: 'inline-block', margin: '0 8px 10px' }}>
        {project.customerMode === 'existing' ? 'Existing / Modernization' : 'New / Greenfield'}
      </span>
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
                {lineage[phase.key as PhaseKey] === 'stale' && (
                  <span className="status-pill danger" title="An upstream phase changed since this was built - see AI Factory">out of date</span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div style={{ margin: '16px 8px 0', paddingTop: 12, borderTop: '1px solid #dfe3e8' }}>
        <div style={{ fontSize: 11, color: '#5a6472', textTransform: 'uppercase', marginBottom: 6 }}>Inference track</div>
        <ul className="phase-nav">
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/ai-factory`} className={({ isActive }) => (isActive ? 'active' : '')}>
                AI Factory (guided)
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/workload-profile`} className={({ isActive }) => (isActive ? 'active' : '')}>
                AI Workload Profile
                {lineage.workload_profile === 'review' && <span className="status-pill warning" title="Discovery changed since this profile was saved">review</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/model-selection`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Model Selection
                {lineage.model_selection === 'stale' && <span className="status-pill danger" title="The Workload Profile changed since this selection was made">out of date</span>}
              </NavLink>
            </li>
          )}
          <li>
            <NavLink to={`/projects/${project.id}/inference`} className={({ isActive }) => (isActive ? 'active' : '')}>
              Inference-as-a-Service
            </NavLink>
          </li>
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/inference-architecture`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Inference Architecture
                {lineage.inference_architecture === 'stale' && <span className="status-pill danger" title="The inference sizing, model selection or workload profile changed since this design">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/infrastructure-design`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Infrastructure Design
                {lineage.infrastructure_design === 'stale' && <span className="status-pill danger" title="Discovery, the workload profile, vector DB selection or the inference design changed since this design">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/rag-agent`} className={({ isActive }) => (isActive ? 'active' : '')}>
                RAG / Agent Architecture
                {lineage.rag_agent_architecture === 'stale' && <span className="status-pill danger" title="Search requirements, the data pipeline, vector DB, model selection or inference design changed since this design">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/security-governance`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Security &amp; Governance
                {lineage.security_governance === 'stale' && <span className="status-pill danger" title="A security requirement or one of the designs it checks changed since this assessment">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/performance`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Performance &amp; Benchmark
                {lineage.performance_benchmark === 'stale' && <span className="status-pill danger" title="A target, a design or a benchmark changed since this assessment">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/finops`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Cost &amp; FinOps
                {lineage.finops === 'stale' && <span className="status-pill danger" title="Sizing, placement or the budget changed since this estimate">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/operations-model`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Operations Model
                {lineage.operations_model === 'stale' && <span className="status-pill danger" title="Targets, capacity or a design changed since this model">out of date</span>}
              </NavLink>
            </li>
          )}
          {features.aiFactory && (
            <li>
              <NavLink to={`/projects/${project.id}/final-recommendation`} className={({ isActive }) => (isActive ? 'active' : '')}>
                Final Recommendation
                {lineage.final_recommendation === 'stale' && <span className="status-pill danger" title="A phase changed since this recommendation was saved">out of date</span>}
              </NavLink>
            </li>
          )}
        </ul>
      </div>
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
