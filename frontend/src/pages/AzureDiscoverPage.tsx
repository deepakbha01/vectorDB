import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorCode, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { AzureBuilderState, AzureEnvironmentProfile, azureBuilderApi, DiscoveryQuery, ModelQuota, ProfileSource } from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { AzureSignInRequired, azureErrorText, signInToAzure } from '../api/azureAuth';
import { TopBar } from '../components/TopBar';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const shortId = (id: string) => id.split('/').pop() ?? id;
const cell = { padding: '6px 8px', verticalAlign: 'top' as const };

interface PolicyForm {
  allowedLocations: string;
  requiredTags: string;
  denyPublicNetworkAccess: boolean;
  secureScore: string;
  hubVnetId: string;
  logAnalyticsId: string;
  modelQuota: ModelQuota[];
}

const EMPTY_POLICY: PolicyForm = { allowedLocations: '', requiredTags: '', denyPublicNetworkAccess: false, secureScore: '', hubVnetId: '', logAnalyticsId: '', modelQuota: [] };

/** Azure AI Factory Builder - Phase 1 (Discover): build the Environment Profile that constrains the design. */
export function AzureDiscoverPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [history, setHistory] = useState<AzureEnvironmentProfile[]>([]);
  const [queries, setQueries] = useState<DiscoveryQuery[]>([]);
  const [source, setSource] = useState<ProfileSource>('sample');
  const [pasted, setPasted] = useState('');
  const [policy, setPolicy] = useState<PolicyForm>(EMPTY_POLICY);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [signInNeeded, setSignInNeeded] = useState(false);

  const load = async () => {
    if (!id) return;
    const [s, h, q] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.profiles(id), azureBuilderApi.queries(id)]);
    setState(s);
    setHistory(h);
    setQueries(q);
    // A live connection reads the subscription itself; the offline sources stay available.
    if (s.connection?.source === 'live') setSource((prev) => (prev === 'sample' ? 'live' : prev));
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load().catch((err) => setError(extractErrorMessage(err, 'Could not load the environment profile.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  const setQuota = (i: number, key: keyof ModelQuota, value: string) =>
    setPolicy({ ...policy, modelQuota: policy.modelQuota.map((q, j) => (j === i ? { ...q, [key]: key === 'limitTpm' || key === 'usedTpm' ? Number(value) : value } : q)) });

  const onRun = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSignInNeeded(false);
    setRunning(true);
    try {
      const form =
        source === 'sample' || source === 'live'
          ? undefined
          : {
              allowedLocations: list(policy.allowedLocations),
              requiredTags: list(policy.requiredTags),
              denyPublicNetworkAccess: policy.denyPublicNetworkAccess,
              ...(policy.secureScore !== '' ? { secureScore: Number(policy.secureScore) } : {}),
              ...(policy.hubVnetId.trim() ? { hubVnetId: policy.hubVnetId.trim() } : {}),
              ...(policy.logAnalyticsId.trim() ? { logAnalyticsId: policy.logAnalyticsId.trim() } : {}),
              modelQuota: policy.modelQuota,
            };
      await azureBuilderApi.discover(id, { source, ...(source === 'resource_graph' ? { resourceGraph: pasted } : {}), ...(form ? { form } : {}) });
      await load();
    } catch (err) {
      const signIn = err instanceof AzureSignInRequired || extractErrorCode(err) === 'AZURE_SIGN_IN_REQUIRED';
      setSignInNeeded(signIn);
      setError(err instanceof AzureSignInRequired ? err.message : extractErrorMessage(err, 'Discover failed.'));
    } finally {
      setRunning(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const profile = state?.environmentProfile ?? null;
  const p = profile?.profile;
  const k = profile?.constraints;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 1" title="Discover" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">Loading...</div>
        ) : !state.connection ? (
          <div className="card">
            Connect a target subscription first - <Link to={`/projects/${project.id}/azure-builder/connect`}>Phase 0: Connect</Link>.
          </div>
        ) : (
          <>
            {state.profileStale && (
              <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--warning)' }}>
                The connection changed since this profile was taken (it was built for connection v{profile?.connectionVersion}, now v{state.connection.version}). Run Discover again.
              </div>
            )}

            <form className="card" style={{ marginBottom: 16 }} onSubmit={onRun} aria-label="Discover form">
              <div className="metric-label" style={{ marginBottom: 8 }}>
                Build the Environment Profile for {state.connection.subscriptionName || state.connection.subscriptionId} · {state.connection.region}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {([
                  ...(state.connection.source === 'live' ? [['live', 'Read from Azure (live)'] as [ProfileSource, string]] : []),
                  ['sample', 'Try the sample landing zone'],
                  ['resource_graph', 'Paste Resource Graph output'],
                  ['form', 'Enter policy only'],
                ] as Array<[ProfileSource, string]>).map(([value, label]) => (
                  <label key={value} className={`checkbox-chip${source === value ? ' checked' : ''}`}>
                    <input type="radio" name="source" checked={source === value} onChange={() => setSource(value)} />
                    {label}
                  </label>
                ))}
              </div>

              {source === 'live' && (
                <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Reads the subscription with your Azure sign-in: VNets, private DNS zones, Log Analytics, Key Vaults and AI accounts (Resource
                  Graph), the policy assignments in force (allowed locations, required tags, public-access denies), Azure OpenAI quota in{' '}
                  {state.connection.region} and the Defender for Cloud secure score. Anything you cannot read is listed as a problem, not a failure.
                </p>
              )}

              {source === 'sample' && (
                <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                  A hub-and-spoke landing zone in Central India with a hub VNet, three private DNS zones, a shared Log Analytics workspace,
                  a Key Vault, an Azure OpenAI account, a deny-public-access policy and model quota. Use it to see how Discover works,
                  then replace it with your own subscription's data.
                </p>
              )}

              {source === 'resource_graph' && (
                <>
                  <details style={{ marginBottom: 10 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Queries to run in the Azure portal (Resource Graph Explorer, Reader access is enough)</summary>
                    {queries.map((q) => (
                      <div key={q.id} style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
                          {q.title}
                          <button type="button" className="status-pill" style={{ cursor: 'pointer' }} onClick={() => navigator.clipboard?.writeText(q.query)}>Copy</button>
                        </div>
                        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--bg)', padding: 8, borderRadius: 6, margin: '4px 0 0' }}>{q.query}</pre>
                      </div>
                    ))}
                  </details>
                  <div className="field">
                    <label htmlFor="resourceGraph">Resource Graph output (JSON - the portal download, or `az graph query -o json`)</label>
                    <textarea id="resourceGraph" rows={8} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='[{ "id": "/subscriptions/...", "name": "vnet-hub", "type": "microsoft.network/virtualnetworks", ... }]' style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
                  </div>
                </>
              )}

              {source !== 'sample' && source !== 'live' && (
                <>
                  <div className="metric-label" style={{ margin: '12px 0 6px' }}>Policy and quota (from Azure Policy and the Azure OpenAI quota page)</div>
                  <div className="field-grid">
                    <div className="field"><label htmlFor="allowedLocations">Allowed locations (comma-separated)</label><input id="allowedLocations" value={policy.allowedLocations} onChange={(e) => setPolicy({ ...policy, allowedLocations: e.target.value })} placeholder="centralindia, southindia" /></div>
                    <div className="field"><label htmlFor="requiredTags">Required tags (comma-separated)</label><input id="requiredTags" value={policy.requiredTags} onChange={(e) => setPolicy({ ...policy, requiredTags: e.target.value })} placeholder="costCenter, owner" /></div>
                    <div className="field"><label htmlFor="secureScore">Defender secure score (optional, 0-100)</label><input id="secureScore" type="number" min={0} max={100} value={policy.secureScore} onChange={(e) => setPolicy({ ...policy, secureScore: e.target.value })} /></div>
                    <div className="field"><label htmlFor="hubVnetId">Hub VNet resource ID (optional override)</label><input id="hubVnetId" value={policy.hubVnetId} onChange={(e) => setPolicy({ ...policy, hubVnetId: e.target.value })} placeholder="/subscriptions/.../virtualNetworks/vnet-hub" /></div>
                    <div className="field"><label htmlFor="logAnalyticsId">Log Analytics resource ID (optional override)</label><input id="logAnalyticsId" value={policy.logAnalyticsId} onChange={(e) => setPolicy({ ...policy, logAnalyticsId: e.target.value })} placeholder="/subscriptions/.../workspaces/log-platform" /></div>
                  </div>
                  <div className="checkbox-grid">
                    <label className={`checkbox-chip${policy.denyPublicNetworkAccess ? ' checked' : ''}`}>
                      <input type="checkbox" checked={policy.denyPublicNetworkAccess} onChange={(e) => setPolicy({ ...policy, denyPublicNetworkAccess: e.target.checked })} />
                      Policy denies public network access (private endpoints required)
                    </label>
                  </div>
                  <div className="metric-label" style={{ margin: '8px 0 6px' }}>Model quota (tokens per minute)</div>
                  {policy.modelQuota.map((q, i) => (
                    <div key={i} className="field-grid" style={{ marginBottom: 6 }}>
                      <div className="field"><label>Region</label><input value={q.region} onChange={(e) => setQuota(i, 'region', e.target.value)} placeholder="centralindia" /></div>
                      <div className="field"><label>Model</label><input value={q.model} onChange={(e) => setQuota(i, 'model', e.target.value)} placeholder="gpt-4o" /></div>
                      <div className="field"><label>Deployment type</label><input value={q.sku} onChange={(e) => setQuota(i, 'sku', e.target.value)} placeholder="Standard" /></div>
                      <div className="field"><label>Limit TPM</label><input type="number" min={0} value={q.limitTpm} onChange={(e) => setQuota(i, 'limitTpm', e.target.value)} /></div>
                      <div className="field"><label>Used TPM</label><input type="number" min={0} value={q.usedTpm} onChange={(e) => setQuota(i, 'usedTpm', e.target.value)} /></div>
                      <button type="button" className="status-pill" style={{ alignSelf: 'end', cursor: 'pointer' }} onClick={() => setPolicy({ ...policy, modelQuota: policy.modelQuota.filter((_, j) => j !== i) })}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="status-pill" style={{ cursor: 'pointer', marginBottom: 12 }} onClick={() => setPolicy({ ...policy, modelQuota: [...policy.modelQuota, { region: state.connection!.region, model: '', sku: 'Standard', limitTpm: 0, usedTpm: 0 }] })}>
                    + Add quota row
                  </button>
                </>
              )}

              {error && <div className="error-text">{error}</div>}
              {signInNeeded && <button type="button" className="primary-btn" style={{ marginRight: 8 }} onClick={() => signInToAzure().catch((err) => setError(azureErrorText(err, 'Could not start the Azure sign-in.')))}>Sign in to Azure</button>}
              <div>
                <button className="primary-btn" type="submit" disabled={running}>{running ? 'Building profile...' : profile ? 'Re-run Discover (new version)' : 'Run Discover'}</button>
              </div>
            </form>

            {p && k && (
              <>
                <div className="card" style={{ marginBottom: 16 }} aria-label="Environment summary">
                  <div className="metric-label" style={{ marginBottom: 8 }}>
                    Environment Profile v{profile!.version} · {profile!.source.replace('_', ' ')} · {new Date(p.scannedAt).toLocaleString()}
                  </div>
                  <div className="card-grid">
                    <div className="card"><div className="metric-label">Resources read</div><div className="metric-value">{p.resourceCount}</div></div>
                    <div className="card"><div className="metric-label">Virtual networks</div><div className="metric-value">{p.network.vnets.length}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>hub: {p.network.hubVnetId ? shortId(p.network.hubVnetId) : 'not identified'}</div></div>
                    <div className="card"><div className="metric-label">Private DNS zones</div><div className="metric-value">{p.network.privateDnsZones.length}</div></div>
                    <div className="card"><div className="metric-label">AI accounts</div><div className="metric-value">{p.ai.existingAccounts.length}</div></div>
                    <div className="card"><div className="metric-label">Secure score</div><div className="metric-value">{p.security.secureScore ?? '-'}</div></div>
                  </div>
                  {profile!.problems.length > 0 && (
                    <ul style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0', paddingLeft: 18 }}>
                      {profile!.problems.map((x) => <li key={x}>{x}</li>)}
                    </ul>
                  )}
                </div>

                <div className="card" style={{ marginBottom: 16 }} aria-label="Design constraints">
                  <div className="metric-label" style={{ marginBottom: 8 }}>What the design must respect</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    <span className={`status-pill ${k.targetRegionAllowed === false ? 'danger' : 'validated'}`}>
                      {k.targetRegionAllowed === null ? `Region ${k.targetRegion} - no region policy` : k.targetRegionAllowed ? `Region ${k.targetRegion} allowed` : `Region ${k.targetRegion} NOT allowed`}
                    </span>
                    <span className={`status-pill ${k.privateEndpointsRequired ? 'warning' : ''}`}>{k.privateEndpointsRequired ? 'Private endpoints required' : 'Public access allowed by policy'}</span>
                    {k.requiredTags.map((t) => <span key={t} className="status-pill">tag: {t}</span>)}
                  </div>
                  {k.reuse.length > 0 && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px' }}>Reuse instead of creating</div>
                      <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
                        {k.reuse.map((r) => <li key={r.component}><strong>{r.component}</strong> {shortId(r.resourceId)} - {r.reason}</li>)}
                      </ul>
                    </>
                  )}
                  {k.missingPrivateDnsZones.length > 0 && (
                    <p style={{ fontSize: 13, margin: '8px 0 0' }}><strong>Missing private DNS zones:</strong> {k.missingPrivateDnsZones.join(', ')}</p>
                  )}
                  {k.modelQuota.length > 0 && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                          <th style={cell}>Model</th><th style={cell}>Type</th><th style={cell}>Limit TPM</th><th style={cell}>Used TPM</th><th style={cell}>Headroom</th>
                        </tr>
                      </thead>
                      <tbody>
                        {k.modelQuota.map((q) => (
                          <tr key={q.model + q.sku} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={cell}>{q.model}</td><td style={cell}>{q.sku}</td><td style={cell}>{q.limitTpm.toLocaleString()}</td><td style={cell}>{q.usedTpm.toLocaleString()}</td>
                            <td style={cell}><span className={`status-pill ${q.headroomPercent < 20 ? 'danger' : 'validated'}`}>{q.headroomPercent}% free</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {k.warnings.length > 0 && (
                    <ul style={{ fontSize: 13, margin: '10px 0 0', paddingLeft: 18, color: 'var(--warning)' }}>
                      {k.warnings.map((w) => <li key={w}>{w}</li>)}
                    </ul>
                  )}
                </div>
              </>
            )}

            {history.length > 1 && (
              <div className="card">
                <div className="metric-label" style={{ marginBottom: 6 }}>Previous versions</div>
                <ul style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>
                  {history.map((h) => (
                    <li key={h.id}>v{h.version} · {h.source.replace('_', ' ')} · for connection v{h.connectionVersion} · {h.profile.resourceCount} resources · {new Date(h.createdAt).toLocaleString()}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
