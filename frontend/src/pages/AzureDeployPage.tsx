import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorCode, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { AzureSignInRequired, signInToAzure } from '../api/azureAuth';
import { AzureApproval, AzureBuilderState, AzureDeployment, AzureIacBundle, AzureWhatIf, azureBuilderApi, TARGET_ENVS, TargetEnv } from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const cell = { padding: '6px 8px', verticalAlign: 'top' as const };
const STATE_PILL: Record<AzureDeployment['state'], string> = { running: 'warning', succeeded: 'validated', failed: 'danger', canceled: 'danger', tearing_down: 'warning', torn_down: '', teardown_failed: 'danger' };
/** How often a running deployment is re-read from Azure while this page is open. */
const POLL_MS = 15_000;

const portalLink = (tenantId: string | undefined, resourceId: string) => `https://portal.azure.com/#@${tenantId ?? ''}/resource${resourceId}`;
const duration = (from: string, to: string | null) => {
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/**
 * Azure AI Factory Builder - Phase 6 (Deploy): deploys an approved bundle as an Azure Deployment Stack
 * (spec 4.7 Mode B) with the user's Azure sign-in, and follows it while the page is open.
 */
export function AzureDeployPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [bundle, setBundle] = useState<AzureIacBundle | null>(null);
  const [approvals, setApprovals] = useState<AzureApproval[]>([]);
  const [whatIfs, setWhatIfs] = useState<AzureWhatIf[]>([]);
  const [deployments, setDeployments] = useState<AzureDeployment[]>([]);
  const [env, setEnv] = useState<TargetEnv>('dev');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);

  const load = async () => {
    if (!id) return;
    const [s, b, a, w, d] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.iacBundles(id), azureBuilderApi.approvals(id), azureBuilderApi.whatIfs(id), azureBuilderApi.deployments(id)]);
    setState(s);
    setBundle(b[0] ?? null);
    setApprovals(a);
    setWhatIfs(w);
    setDeployments(d);
  };

  const fail = (err: unknown, fallback: string) => {
    setSignInNeeded(err instanceof AzureSignInRequired || extractErrorCode(err) === 'AZURE_SIGN_IN_REQUIRED');
    setError(err instanceof AzureSignInRequired ? err.message : extractErrorMessage(err, fallback));
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load().catch((err) => fail(err, 'Could not load the deployments.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  // Follow running deployments: the server holds no Azure token, so the open page asks it to re-read Azure with a fresh one.
  const running = deployments.filter((d) => d.state === 'running' || d.state === 'tearing_down');
  useEffect(() => {
    if (!id || running.length === 0 || signInNeeded) return;
    const timer = setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const updated = await Promise.all(running.map((d) => azureBuilderApi.refreshDeployment(id, d.id)));
        setDeployments((all) => all.map((d) => updated.find((u) => u.id === d.id) ?? d));
      } catch (err) {
        fail(err, 'Could not read the deployment status from Azure.');
      } finally {
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, running.map((d) => d.id).join(','), signInNeeded]);

  const onDeploy = async () => {
    if (!id) return;
    setError(null);
    setSignInNeeded(false);
    setBusy(true);
    try {
      const d = await azureBuilderApi.deploy(id, env);
      setDeployments((all) => [d, ...all]);
      setConfirmed(false);
    } catch (err) {
      fail(err, 'The deployment could not be started.');
    } finally {
      setBusy(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const c = state?.connection ?? null;
  const decisionFor = (e: TargetEnv) => (bundle ? approvals.find((a) => a.environment === e && a.iacVersion === bundle.version) ?? null : null);
  const evidenceFor = (a: AzureApproval | null) => (a ? whatIfs.find((w) => w.id === a.whatIfId) ?? null : null);
  const readiness = (e: TargetEnv): { ok: boolean; label: string; reason: string | null } => {
    const a = decisionFor(e);
    const w = evidenceFor(a);
    if (!a) return { ok: false, label: 'not approved', reason: `Bundle v${bundle?.version} has no decision for ${e} - approve it in Phase 5.` };
    if (a.decision !== 'approved') return { ok: false, label: 'rejected', reason: `The latest ${e} decision is a rejection: ${a.comments ?? ''}` };
    if (!(w?.source === 'arm' && w.report.armOrigin === 'live')) return { ok: false, label: 'needs live what-if', reason: `The ${e} approval rests on ${w?.source === 'arm' ? 'a pasted' : 'the offline'} what-if. Run a live what-if in Phase 5 and approve again.` };
    if (deployments.some((d) => d.environment === e && d.state === 'running')) return { ok: false, label: 'deploying', reason: `A ${e} deployment is running.` };
    if (deployments.some((d) => d.environment === e && d.state === 'tearing_down')) return { ok: false, label: 'deploying', reason: `The ${e} stack is being torn down.` };
    return { ok: true, label: 'ready', reason: null };
  };
  const ready = readiness(env);
  const stale = !!(state && (state.architectureStale || state.iacStale));

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 6" title="Deploy" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">{error ?? 'Loading...'}</div>
        ) : !c || c.source !== 'live' ? (
          <div className="card">
            Deploying from the app needs a live connection - <Link to={`/projects/${project.id}/azure-builder/connect`}>connect with your Azure sign-in (Phase 0)</Link>. Offline, deploy the bundle with its
            GitHub Actions workflow instead.
          </div>
        ) : !bundle ? (
          <div className="card">Generate the infrastructure code first - <Link to={`/projects/${project.id}/azure-builder/iac`}>Phase 4</Link>.</div>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }} aria-label="Deployment target">
              <div className="metric-label" style={{ marginBottom: 8 }}>
                IaC bundle v{bundle.version} · <code>{bundle.root}</code> → {c.subscriptionName ?? c.subscriptionId} / {c.resourceGroup} · as an Azure Deployment Stack
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist">
                {TARGET_ENVS.map((e) => {
                  const r = readiness(e);
                  return (
                    <button key={e} type="button" role="tab" aria-selected={env === e} className={`checkbox-chip${env === e ? ' checked' : ''}`} onClick={() => { setEnv(e); setError(null); setConfirmed(false); }}>
                      {e} <span className={`status-pill ${r.ok ? 'validated' : r.label === 'deploying' ? 'warning' : ''}`} style={{ marginLeft: 6 }}>{r.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }} aria-label="Deploy">
              <div className="metric-label" style={{ marginBottom: 8 }}>Deploy {env}</div>
              {stale ? (
                <p style={{ fontSize: 13, margin: 0 }}>The design changed since bundle v{bundle.version} was generated - generate, validate and approve it again first.</p>
              ) : ready.reason ? (
                <p style={{ fontSize: 13, margin: 0 }}>{ready.reason} {ready.label !== 'deploying' && <Link to={`/projects/${project.id}/azure-builder/approve`}>Go to Phase 5</Link>}</p>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px' }}>
                    Compiles bundle v{bundle.version} with <code>{env}.bicepparam</code> and creates or updates the Deployment Stack <code>azb-{bundle.workload}-{env}</code> in {c.resourceGroup},
                    as your Azure account. The stack denies deleting its resources outside the stack when your role allows deny settings. Resources are billable from the moment they are created.
                  </p>
                  <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 10 }}>
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    I understand this creates billable Azure resources in {c.subscriptionName ?? c.subscriptionId} / {c.resourceGroup}.
                  </label>
                  <button className="primary-btn" type="button" disabled={busy || !confirmed} onClick={onDeploy}>{busy ? 'Compiling and submitting...' : `Deploy ${env} to Azure`}</button>
                </>
              )}
              {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
              {signInNeeded && (
                <button type="button" className="primary-btn" style={{ marginTop: 8 }} onClick={() => signInToAzure().catch((e) => setError(extractErrorMessage(e, 'Could not start the Azure sign-in.')))}>
                  Sign in to Azure
                </button>
              )}
            </div>

            {deployments.length > 0 && (
              <div className="card" aria-label="Deployments">
                <div className="metric-label" style={{ marginBottom: 6 }}>Deployments {running.length > 0 && <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· checking Azure every {POLL_MS / 1000}s while this page is open</span>}</div>
                {deployments.map((d) => (
                  <div key={d.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className={`status-pill ${STATE_PILL[d.state]}`}>{d.state.replace('_', ' ')}</span>
                      <strong style={{ fontSize: 13 }}>{d.environment}</strong>
                      <span style={{ fontSize: 12 }}>bundle v{d.iacVersion} · {d.stackName} · {d.provisioningState}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {d.denyMode === 'denyDelete' ? 'deny-delete on' : 'no deny settings (needs Owner)'}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
                        {new Date(d.createdAt).toLocaleString()} · {duration(d.createdAt, d.finishedAt)} · {d.azureUser ?? d.deployedByEmail}
                      </span>
                    </div>
                    {d.stackId && <div style={{ fontSize: 12, marginTop: 4 }}><a href={portalLink(c.tenantId, d.stackId)} target="_blank" rel="noreferrer">Open the stack in the Azure portal</a></div>}
                    {d.errors.length > 0 && (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
                        <tbody>
                          {d.errors.map((e, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ ...cell, color: 'var(--danger)', whiteSpace: 'nowrap' }}>{e.code}</td>
                              <td style={cell}>{e.message}{e.resource && <div style={{ color: 'var(--muted)', wordBreak: 'break-all' }}>{e.resource}</div>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {Object.keys(d.outputs).length > 0 && (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
                        <tbody>
                          {Object.entries(d.outputs).map(([k, v]) => (
                            <tr key={k} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ ...cell, whiteSpace: 'nowrap', fontWeight: 600 }}>{k}</td>
                              <td style={{ ...cell, wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>{typeof v === 'string' ? v : JSON.stringify(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {d.state === 'succeeded' && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{d.resourceIds.length} resource(s) managed by the stack. <Link to={`/projects/${project.id}/azure-builder/operate`}>Operate it (Phase 7)</Link></div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
