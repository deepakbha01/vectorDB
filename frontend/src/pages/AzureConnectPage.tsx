import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { AzureBuilderState, AzureConnection, AzureConnectionInput, azureBuilderApi, REGIONS } from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const EMPTY: AzureConnectionInput = {
  tenantId: '',
  subscriptionId: '',
  subscriptionName: '',
  resourceGroup: '',
  resourceGroupMode: 'new',
  region: 'centralindia',
  deploymentModel: 'hub_and_spoke',
  role: 'contributor',
};

const MODEL_LABEL = { centralised: 'Centralised', hub_and_spoke: 'Hub-and-spoke', federated: 'Federated' } as const;

/** Azure AI Factory Builder - Phase 0 (Connect): declare the target subscription, resource group and region. */
export function AzureConnectPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [history, setHistory] = useState<AzureConnection[]>([]);
  const [form, setForm] = useState<AzureConnectionInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!id) return;
    const [s, h] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.connections(id)]);
    setState(s);
    setHistory(h);
    if (s.connection) {
      const c = s.connection;
      setForm({ tenantId: c.tenantId, subscriptionId: c.subscriptionId, subscriptionName: c.subscriptionName ?? '', resourceGroup: c.resourceGroup, resourceGroupMode: c.resourceGroupMode, region: c.region, deploymentModel: c.deploymentModel, role: c.role });
    }
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load().catch((err) => setError(extractErrorMessage(err, 'Could not load the Azure connection.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  const set = <K extends keyof AzureConnectionInput>(key: K, value: AzureConnectionInput[K]) => setForm({ ...form, [key]: value });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSaving(true);
    try {
      await azureBuilderApi.connect(id, { ...form, subscriptionName: form.subscriptionName?.trim() || undefined });
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save the connection.'));
    } finally {
      setSaving(false);
    }
  };

  const onDisconnect = async () => {
    if (!id) return;
    setError(null);
    try {
      await azureBuilderApi.disconnect(id);
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not disconnect.'));
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const c = state?.connection ?? null;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 0" title="Connect" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
                Declare the Azure subscription, resource group and region this use case will deploy into. <strong>Offline mode:</strong> no
                sign-in, password, key or token is entered or stored - the role you hold is declared here and verified against Azure in
                the live-connection wave. A Reader can design; deploying needs Contributor or Owner.
              </p>
            </div>

            {c && (
              <div className="card" style={{ marginBottom: 16 }} aria-label="Current Azure target">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <div className="metric-label" style={{ margin: 0 }}>Current target (version {c.version})</div>
                  <span className={`status-pill ${c.permission.canDeploy ? 'validated' : 'warning'}`}>{c.permission.canDeploy ? 'Can design and deploy' : 'Design only'}</span>
                  <span className="status-pill">{c.source === 'declared' ? 'Declared (offline)' : 'Verified live'}</span>
                </div>
                <div className="card-grid">
                  <div className="card"><div className="metric-label">Subscription</div><div style={{ fontSize: 13 }}>{c.subscriptionName || c.subscriptionId}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.subscriptionId}</div></div>
                  <div className="card"><div className="metric-label">Resource group</div><div style={{ fontSize: 13 }}>{c.resourceGroup}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.resourceGroupMode === 'new' ? 'to be created' : 'existing'}</div></div>
                  <div className="card"><div className="metric-label">Region</div><div style={{ fontSize: 13 }}>{REGIONS.find((r) => r.value === c.region)?.label ?? c.region}</div></div>
                  <div className="card"><div className="metric-label">Deployment model</div><div style={{ fontSize: 13 }}>{MODEL_LABEL[c.deploymentModel]}</div></div>
                </div>
                <p style={{ fontSize: 13, margin: '10px 0' }}>{c.permission.note}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Link className="primary-btn" style={{ textDecoration: 'none' }} to={`/projects/${project.id}/azure-builder/discover`}>Next: Discover the environment</Link>
                  <button type="button" className="primary-btn" style={{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' }} onClick={onDisconnect}>
                    Disconnect
                  </button>
                </div>
              </div>
            )}

            <form className="card" style={{ marginBottom: 16 }} onSubmit={onSubmit} aria-label="Azure target form">
              <div className="metric-label" style={{ marginBottom: 10 }}>{c ? 'Change the target (creates a new version)' : 'Connect a target'}</div>
              <div className="field-grid">
                <div className="field"><label htmlFor="tenantId">Tenant ID</label><input id="tenantId" value={form.tenantId} onChange={(e) => set('tenantId', e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" required /></div>
                <div className="field"><label htmlFor="subscriptionId">Subscription ID</label><input id="subscriptionId" value={form.subscriptionId} onChange={(e) => set('subscriptionId', e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" required /></div>
                <div className="field"><label htmlFor="subscriptionName">Subscription name (optional)</label><input id="subscriptionName" value={form.subscriptionName ?? ''} onChange={(e) => set('subscriptionName', e.target.value)} placeholder="e.g. sub-ai-spoke-dev" /></div>
                <div className="field"><label htmlFor="resourceGroup">Resource group</label><input id="resourceGroup" value={form.resourceGroup} onChange={(e) => set('resourceGroup', e.target.value.trim())} placeholder="rg-uc-hr-assistant-dev-cin" required /></div>
                <div className="field">
                  <label htmlFor="resourceGroupMode">Resource group is</label>
                  <select id="resourceGroupMode" value={form.resourceGroupMode} onChange={(e) => set('resourceGroupMode', e.target.value as AzureConnectionInput['resourceGroupMode'])}>
                    <option value="new">New - created at deploy time</option>
                    <option value="existing">Existing</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="region">Region</label>
                  <select id="region" value={form.region} onChange={(e) => set('region', e.target.value)}>
                    {!REGIONS.some((r) => r.value === form.region) && <option value={form.region}>{form.region}</option>}
                    {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="deploymentModel">Deployment model</label>
                  <select id="deploymentModel" value={form.deploymentModel} onChange={(e) => set('deploymentModel', e.target.value as AzureConnectionInput['deploymentModel'])}>
                    <option value="hub_and_spoke">Hub-and-spoke (default) - use case in a spoke, shared services in the hub</option>
                    <option value="centralised">Centralised - one platform subscription for all use cases</option>
                    <option value="federated">Federated - each business unit brings its own subscription</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="role">Your role on this scope</label>
                  <select id="role" value={form.role} onChange={(e) => set('role', e.target.value as AzureConnectionInput['role'])}>
                    <option value="owner">Owner</option>
                    <option value="contributor">Contributor</option>
                    <option value="reader">Reader (design only)</option>
                    <option value="unknown">Not sure</option>
                  </select>
                </div>
              </div>
              {error && <div className="error-text">{error}</div>}
              <button className="primary-btn" type="submit" disabled={saving}>{saving ? 'Saving...' : c ? 'Save new version' : 'Connect'}</button>
            </form>

            {history.length > 0 && (
              <div className="card">
                <div className="metric-label" style={{ marginBottom: 6 }}>History</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 8px' }}>v{h.version}</td>
                        <td style={{ padding: '6px 8px' }}>{h.active ? 'Connected' : 'Disconnected'}</td>
                        <td style={{ padding: '6px 8px' }}>{h.subscriptionName || h.subscriptionId}</td>
                        <td style={{ padding: '6px 8px' }}>{h.resourceGroup}</td>
                        <td style={{ padding: '6px 8px' }}>{h.region}</td>
                        <td style={{ padding: '6px 8px' }}>{h.role}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{new Date(h.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
