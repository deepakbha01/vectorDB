import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorCode, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { AzureSignInRequired, azureErrorText, signInToAzure } from '../api/azureAuth';
import { AzureBuilderState, AzureDeployment, AzureOperateCheck, azureBuilderApi, CheckStatus, TARGET_ENVS, TargetEnv } from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const cell = { padding: '6px 8px', verticalAlign: 'top' as const };
const PILL: Record<CheckStatus | 'info', string> = { passed: 'validated', failed: 'danger', warning: 'warning', skipped: '', info: '' };
const POLL_MS = 15_000;
const DAY_MS = 24 * 3600 * 1000;
const NEXT_ENV: Partial<Record<TargetEnv, TargetEnv>> = { dev: 'test', test: 'prod' };
const ago = (iso: string) => {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

/**
 * Azure AI Factory Builder - Phase 7 (Operate): smoke tests, budget, drift, promotion and teardown of a
 * deployed environment (spec 4.8), each with the user's Azure sign-in.
 */
export function AzureOperatePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [deployments, setDeployments] = useState<AzureDeployment[]>([]);
  const [checks, setChecks] = useState<AzureOperateCheck[]>([]);
  const [env, setEnv] = useState<TargetEnv>('dev');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetEmails, setBudgetEmails] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signInNeeded, setSignInNeeded] = useState(false);
  const polling = useRef(false);

  const load = async () => {
    if (!id) return;
    const [s, d, c] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.deployments(id), azureBuilderApi.operateChecks(id)]);
    setState(s);
    setDeployments(d);
    setChecks(c);
  };

  const fail = (err: unknown, fallback: string) => {
    setSignInNeeded(err instanceof AzureSignInRequired || extractErrorCode(err) === 'AZURE_SIGN_IN_REQUIRED');
    setError(err instanceof AzureSignInRequired ? err.message : extractErrorMessage(err, fallback));
  };

  const act = async (label: string, fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setSignInNeeded(false);
    setBusy(label);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      fail(err, fallback);
      return false;
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load().catch((err) => fail(err, 'Could not load the deployments.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  // The latest deployment of each environment is the one Operate acts on.
  const current = deployments.find((d) => d.environment === env) ?? null;

  // Follow a teardown (or a deployment still running) while the page is open.
  useEffect(() => {
    if (!id || !current || (current.state !== 'tearing_down' && current.state !== 'running') || signInNeeded) return;
    const timer = setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const updated = await azureBuilderApi.refreshDeployment(id, current.id);
        setDeployments((all) => all.map((d) => (d.id === updated.id ? updated : d)));
      } catch (err) {
        fail(err, 'Could not read the status from Azure.');
      } finally {
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, current?.id, current?.state, signInNeeded]);

  if (!project) return <div className="main-content">Loading...</div>;
  const c = state?.connection ?? null;
  const tenant = c?.tenantId ?? '';
  const portal = (resourceId: string, blade = '') => `https://portal.azure.com/#@${tenant}/resource${resourceId}${blade}`;
  const forCurrent = (kind: AzureOperateCheck['kind']) => (current ? checks.find((k) => k.deploymentId === current.id && k.kind === kind) ?? null : null);
  const smoke = forCurrent('smoke');
  const drift = forCurrent('drift');
  const budget = forCurrent('budget');
  const operable = current?.state === 'succeeded';
  const appInsights = current?.resourceIds.find((r) => /\/microsoft\.insights\/components\//i.test(r));
  const workspace = current?.resourceIds.find((r) => /\/microsoft\.operationalinsights\/workspaces\//i.test(r));
  const next = NEXT_ENV[env];
  const nextDeployed = next ? deployments.find((d) => d.environment === next) : null;

  const checkTable = (rows: NonNullable<AzureOperateCheck['result']['checks']>) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ ...cell, whiteSpace: 'nowrap' }}><span className={`status-pill ${PILL[r.status]}`}>{r.status}</span></td>
            <td style={{ ...cell, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.name}</td>
            <td style={cell}>{r.detail}{r.resources?.length ? <div style={{ color: 'var(--muted)', wordBreak: 'break-all' }}>{r.resources.join(' · ')}</div> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 7" title="Operate" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">{error ?? 'Loading...'}</div>
        ) : deployments.length === 0 ? (
          <div className="card">Nothing is deployed yet - <Link to={`/projects/${project.id}/azure-builder/deploy`}>Phase 6: Deploy</Link>.</div>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }} aria-label="Environment">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist">
                {TARGET_ENVS.map((e) => {
                  const d = deployments.find((x) => x.environment === e);
                  return (
                    <button key={e} type="button" role="tab" aria-selected={env === e} className={`checkbox-chip${env === e ? ' checked' : ''}`} onClick={() => { setEnv(e); setError(null); setConfirm(''); }}>
                      {e} <span className={`status-pill ${d?.state === 'succeeded' ? 'validated' : d?.state.includes('fail') ? 'danger' : ''}`} style={{ marginLeft: 6 }}>{d ? d.state.replace('_', ' ') : 'not deployed'}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {error && (
              <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--danger)' }}>
                <div className="error-text">{error}</div>
                {signInNeeded && <button type="button" className="primary-btn" style={{ marginTop: 8 }} onClick={() => signInToAzure().catch((e) => setError(azureErrorText(e, 'Could not start the Azure sign-in.')))}>Sign in to Azure</button>}
              </div>
            )}

            {!current ? (
              <div className="card">{env} is not deployed. <Link to={`/projects/${project.id}/azure-builder/deploy`}>Deploy it in Phase 6</Link>.</div>
            ) : (
              <>
                <div className="card" style={{ marginBottom: 16 }} aria-label="Deployment">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className={`status-pill ${current.state === 'succeeded' ? 'validated' : current.state.includes('fail') ? 'danger' : 'warning'}`}>{current.state.replace('_', ' ')}</span>
                    <strong style={{ fontSize: 13 }}>{current.stackName}</strong>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>bundle v{current.iacVersion} · {current.resourceIds.length} resource(s) · deployed {ago(current.createdAt)} by {current.azureUser ?? current.deployedByEmail}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
                    {current.stackId && current.state !== 'torn_down' && <a href={portal(current.stackId)} target="_blank" rel="noreferrer">Deployment stack</a>}
                    <a href={portal(`/subscriptions/${current.subscriptionId}/resourceGroups/${current.resourceGroup}`, '/costanalysis')} target="_blank" rel="noreferrer">Cost analysis ({current.resourceGroup})</a>
                    {appInsights && <a href={portal(appInsights)} target="_blank" rel="noreferrer">Application Insights</a>}
                    {workspace && <a href={portal(workspace, '/logs')} target="_blank" rel="noreferrer">Log Analytics</a>}
                  </div>
                  {current.state === 'tearing_down' && <p style={{ fontSize: 13, margin: '10px 0 0' }}>Deleting the stack and its resources - checking Azure every {POLL_MS / 1000}s while this page is open.</p>}
                  {current.state === 'torn_down' && <p style={{ fontSize: 13, margin: '10px 0 0' }}>Torn down {current.finishedAt ? ago(current.finishedAt) : ''}. Deploy again from <Link to={`/projects/${project.id}/azure-builder/deploy`}>Phase 6</Link>.</p>}
                  {current.errors.length > 0 && <div className="error-text" style={{ marginTop: 8 }}>{current.errors.map((e) => `${e.code}: ${e.message}`).join(' · ')}</div>}
                </div>

                {operable && (
                  <>
                    <div className="card" style={{ marginBottom: 16 }} aria-label="Smoke tests">
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div className="metric-label" style={{ margin: 0 }}>Smoke tests</div>
                        {smoke && <span className={`status-pill ${PILL[smoke.status]}`}>{smoke.status}</span>}
                        {smoke && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{smoke.summary} · {ago(smoke.createdAt)}</span>}
                        <button type="button" className="primary-btn" style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={() => act('smoke', () => azureBuilderApi.smokeTests(id!, current.id), 'The smoke tests could not run.')}>
                          {busy === 'smoke' ? 'Checking...' : 'Run smoke tests'}
                        </button>
                      </div>
                      {smoke?.result.checks && checkTable(smoke.result.checks)}
                    </div>

                    <div className="card" style={{ marginBottom: 16 }} aria-label="Budget">
                      <div className="metric-label" style={{ marginBottom: 6 }}>Budget</div>
                      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px' }}>
                        A monthly cost budget on {current.resourceGroup} with email alerts at 80% and 100% of actual cost. The amount is in your subscription's billing currency; blank uses the use case budget, else the estimate.
                        {budget && <> Current: <strong>{budget.result.amount}</strong> per month, alerts to {budget.result.contactEmails?.join(', ')} (set {ago(budget.createdAt)}).</>}
                      </p>
                      <div className="field-grid">
                        <div className="field"><label htmlFor="budgetAmount">Monthly amount</label><input id="budgetAmount" type="number" min={1} value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} placeholder={budget ? String(budget.result.amount) : 'default'} /></div>
                        <div className="field"><label htmlFor="budgetEmails">Alert emails (comma-separated)</label><input id="budgetEmails" value={budgetEmails} onChange={(e) => setBudgetEmails(e.target.value)} placeholder="default: your Azure account" /></div>
                      </div>
                      <button type="button" className="primary-btn" disabled={!!busy} onClick={() => act('budget', () => azureBuilderApi.setBudget(id!, current.id, {
                        ...(budgetAmount ? { amountUsd: Number(budgetAmount) } : {}),
                        ...(budgetEmails.trim() ? { contactEmails: budgetEmails.split(',').map((e) => e.trim()).filter(Boolean) } : {}),
                      }), 'The budget could not be set.')}>
                        {busy === 'budget' ? 'Saving...' : budget ? 'Update budget' : 'Create budget'}
                      </button>
                    </div>

                    <div className="card" style={{ marginBottom: 16 }} aria-label="Drift">
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div className="metric-label" style={{ margin: 0 }}>Drift</div>
                        {drift && <span className={`status-pill ${PILL[drift.status]}`}>{drift.status === 'passed' ? 'no drift' : drift.status}</span>}
                        {drift && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{drift.summary} · {ago(drift.createdAt)}</span>}
                        <button type="button" className="primary-btn" style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={() => act('drift', () => azureBuilderApi.driftCheck(id!, current.id), 'The drift check could not run.')}>
                          {busy === 'drift' ? 'Asking Azure (up to a few minutes)...' : 'Check drift now'}
                        </button>
                      </div>
                      <p style={{ fontSize: 12, color: drift && Date.now() - new Date(drift.createdAt).getTime() < DAY_MS ? 'var(--muted)' : 'var(--warning)', margin: '6px 0 0' }}>
                        {!drift ? 'Never checked. ' : Date.now() - new Date(drift.createdAt).getTime() > DAY_MS ? 'Last checked more than a day ago. ' : ''}
                        A what-if of bundle v{current.iacVersion} against the resource group: anything other than "no change" means the resources no longer match what was approved. Runs on demand - a scheduled daily check needs a service principal, because no sign-in is stored.
                      </p>
                      {drift?.result.items && drift.result.items.length > 0 && (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
                          <tbody>
                            {drift.result.items.map((i) => (
                              <tr key={i.resource + i.changeType} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ ...cell, whiteSpace: 'nowrap' }}><span className={`status-pill ${i.changeType === 'Create' || i.changeType === 'Delete' ? 'danger' : 'warning'}`}>{i.changeType === 'Create' ? 'missing' : i.changeType === 'Modify' ? 'changed' : i.changeType}</span></td>
                                <td style={{ ...cell, wordBreak: 'break-all' }}>{i.resource}</td>
                                <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--muted)' }}>{i.changeType === 'Modify' ? `${i.propertyChanges} propert${i.propertyChanges === 1 ? 'y' : 'ies'}` : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    {next && (
                      <div className="card" style={{ marginBottom: 16 }} aria-label="Promote">
                        <div className="metric-label" style={{ marginBottom: 6 }}>Promote to {next}</div>
                        <p style={{ fontSize: 13, margin: 0 }}>
                          {nextDeployed ? `${next} is ${nextDeployed.state.replace('_', ' ')} (bundle v${nextDeployed.iacVersion}). ` : ''}
                          Promotion re-runs Phases 5-6 with <code>{next}.bicepparam</code>: <Link to={`/projects/${project.id}/azure-builder/approve`}>validate and approve bundle v{current.iacVersion} for {next}</Link>
                          {next === 'prod' ? ' (by someone other than the bundle author)' : ''}, then <Link to={`/projects/${project.id}/azure-builder/deploy`}>deploy it</Link>.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {current.stackId && (current.state === 'succeeded' || current.state === 'failed' || current.state === 'teardown_failed' || current.state === 'canceled') && (
                  <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--danger)' }} aria-label="Teardown">
                    <div className="metric-label" style={{ marginBottom: 6 }}>Tear down {env}</div>
                    <p style={{ fontSize: 13, margin: '0 0 8px' }}>
                      Deletes the stack <code>{current.stackName}</code>, the {current.resourceIds.length} resource(s) it manages and its budget. Nothing outside the stack is touched; resources detached by an
                      earlier update stay. Key Vault and AI accounts go to soft delete - purge them before reusing their names.{env === 'prod' ? ' Production needs an admin.' : ''}
                    </p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input aria-label="Type the environment to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`type "${env}" to confirm`} style={{ maxWidth: 220 }} />
                      <button type="button" className="primary-btn" style={{ background: 'var(--danger)' }} disabled={!!busy || confirm.trim() !== env}
                        onClick={async () => { if (await act('teardown', () => azureBuilderApi.teardown(id!, current.id, confirm.trim()), 'The teardown could not start.')) setConfirm(''); }}>
                        {busy === 'teardown' ? 'Requesting...' : `Tear down ${env}`}
                      </button>
                    </div>
                  </div>
                )}

                {checks.some((k) => k.environment === env) && (
                  <div className="card" aria-label="History">
                    <div className="metric-label" style={{ marginBottom: 6 }}>History ({env})</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <tbody>
                        {checks.filter((k) => k.environment === env).slice(0, 30).map((k) => (
                          <tr key={k.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--muted)' }}>{new Date(k.createdAt).toLocaleString()}</td>
                            <td style={{ ...cell, whiteSpace: 'nowrap' }}>{k.kind}</td>
                            <td style={{ ...cell, whiteSpace: 'nowrap' }}><span className={`status-pill ${PILL[k.status]}`}>{k.status}</span></td>
                            <td style={cell}>{k.summary}</td>
                            <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--muted)' }}>{k.createdByEmail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
