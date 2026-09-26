import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, DeploymentExecutionResult, DeploymentPlan, extractErrorMessage, Project } from '../api/client';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title}</p>
      <pre style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 6, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
        {code}
      </pre>
    </div>
  );
}

export function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<DeploymentExecutionResult | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);

  const load = () => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient
      .get<DeploymentPlan>(`/projects/${id}/deployment/plans/latest`)
      .then((res) => setPlan(res.data))
      .catch(() => setPlan(null));
  };

  useEffect(load, [id]);

  const onGenerate = async () => {
    if (!id) return;
    setError(null);
    setGenerating(true);
    try {
      const { data } = await apiClient.post<DeploymentPlan>(`/projects/${id}/deployment/plans`);
      setPlan(data);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not generate the deployment plan.'));
    } finally {
      setGenerating(false);
    }
  };

  const onExecute = async () => {
    if (!id) return;
    setExecutionError(null);
    setExecuting(true);
    try {
      const { data } = await apiClient.post<DeploymentExecutionResult>(`/projects/${id}/deployment/execute`);
      setExecutionResult(data);
      load();
    } catch (err: any) {
      setExecutionError(extractErrorMessage(err, 'Deployment execution failed.'));
    } finally {
      setExecuting(false);
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
        <TopBar title="Phase 4 - Implementation: Provisioning & Deployment" />

        {!plan && (
          <div className="card" style={{ maxWidth: 560 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              Generates SQL/schema scripts, Terraform (and Kubernetes/Helm for Milvus), a deployment checklist, health
              check, and rollback procedure from your Phase 2 (Data & Embeddings) and Phase 3 (Index Design) outputs.
              This step only generates the plan - nothing is provisioned yet.
            </p>
            {error && <div className="error-text">{error}</div>}
            <button className="primary-btn" onClick={onGenerate} disabled={generating}>
              {generating ? 'Generating...' : 'Generate Deployment Plan'}
            </button>
          </div>
        )}

        {plan && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <button className="primary-btn" onClick={onGenerate} disabled={generating}>
                {generating ? 'Regenerating...' : `Regenerate Plan (v${plan.version + 1})`}
              </button>
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Target platform</div>
                <div className="metric-value" style={{ fontSize: 18 }}>
                  {plan.platform}
                </div>
              </div>
              <div className="card">
                <div className="metric-label">Collection / table</div>
                <div className="metric-value" style={{ fontSize: 18 }}>
                  {plan.collectionName}
                </div>
              </div>
              <div className="card">
                <div className="metric-label">Status</div>
                <div className="metric-value" style={{ fontSize: 16 }}>
                  {plan.executed ? `Executed ${new Date(plan.executedAt!).toLocaleString()}` : 'Not yet executed'}
                </div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <CodeBlock title="SQL / schema script" code={plan.sqlScript} />
              <CodeBlock title="Terraform (starting point - fill in provider-specific values)" code={plan.terraform} />
              {plan.kubernetesArtifacts && (
                <>
                  <CodeBlock title="Kubernetes namespace" code={plan.kubernetesArtifacts.namespaceYaml} />
                  <CodeBlock title="Kubernetes secret (placeholder values)" code={plan.kubernetesArtifacts.secretYaml} />
                  <CodeBlock title="Helm values (milvus/milvus chart)" code={plan.kubernetesArtifacts.helmValuesYaml} />
                </>
              )}
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Health check</div>
                <p style={{ fontSize: 13 }}>{plan.healthCheck.description}</p>
                <code style={{ fontSize: 12 }}>{plan.healthCheck.check}</code>
              </div>
              <div className="card">
                <div className="metric-label">Deployment checklist</div>
                <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {plan.deploymentChecklist.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
              <div className="card">
                <div className="metric-label">Rollback procedure</div>
                <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {plan.rollbackProcedure.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="card" style={{ maxWidth: 560 }}>
              <div className="metric-label" style={{ marginBottom: 8 }}>
                Execute deployment
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                Connects to the target database using this server's TARGET_* environment variables, runs a health
                check, then creates the schema and vector index above. This never drops or deletes anything.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '10px 0' }}>
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                I understand this will attempt to connect to the configured target database and create real schema
                objects there.
              </label>
              {executionError && <div className="error-text">{executionError}</div>}
              {executionResult && (
                <div className="status-pill validated" style={{ display: 'inline-block', marginBottom: 8 }}>
                  Health check passed - schema and index created
                </div>
              )}
              <div>
                <button className="primary-btn" onClick={onExecute} disabled={!acknowledged || executing}>
                  {executing ? 'Executing...' : 'Execute Deployment'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
