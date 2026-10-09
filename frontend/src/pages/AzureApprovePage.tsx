import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorCode, extractErrorMessage, Project } from '../api/client';
import { AzureSignInRequired, azureErrorText, signInToAzure } from '../api/azureAuth';
import { useFeatures } from '../api/features';
import {
  AzureApproval,
  AzureBuilderState,
  AzureIacBundle,
  AzureWhatIf,
  azureBuilderApi,
  ChangeType,
  RAI_CHECKLIST,
  TARGET_ENVS,
  TargetEnv,
} from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const cell = { padding: '6px 8px', verticalAlign: 'top' as const };
const CHANGE_PILL: Record<ChangeType, string> = { Create: 'validated', Modify: 'warning', Delete: 'danger', NoChange: '', Ignore: '', Deploy: '', Unsupported: 'warning' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const short = (h: string) => h.slice(0, 12);

/** Azure AI Factory Builder - Phase 5 (Validate & approve): what-if, validation report and an immutable, hash-bound decision. */
export function AzureApprovePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [bundle, setBundle] = useState<AzureIacBundle | null>(null);
  const [whatIfs, setWhatIfs] = useState<AzureWhatIf[]>([]);
  const [approvals, setApprovals] = useState<AzureApproval[]>([]);
  const [env, setEnv] = useState<TargetEnv>('dev');
  const [source, setSource] = useState<'planned' | 'arm' | 'live'>('planned');
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [pasted, setPasted] = useState('');
  const [comments, setComments] = useState('');
  const [rai, setRai] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!id) return;
    const [s, b, w, a] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.iacBundles(id), azureBuilderApi.whatIfs(id), azureBuilderApi.approvals(id)]);
    setState(s);
    // With a live connection the server can run the what-if itself - the evidence a deployment from the app needs.
    if (s.connection?.source === 'live') setSource((prev) => (prev === 'planned' ? 'live' : prev));
    setBundle(b[0] ?? null);
    setWhatIfs(w);
    setApprovals(a);
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load().catch((err) => setError(extractErrorMessage(err, 'Could not load the validation state.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  const act = async (fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setSignInNeeded(false);
    setBusy(true);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setSignInNeeded(err instanceof AzureSignInRequired || extractErrorCode(err) === 'AZURE_SIGN_IN_REQUIRED');
      setError(err instanceof AzureSignInRequired ? err.message : extractErrorMessage(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onWhatIf = () => act(() => azureBuilderApi.runWhatIf(id!, { environment: env, source, ...(source === 'arm' ? { result: pasted } : {}) }), 'The what-if could not be run.');
  const onDecide = async (decision: 'approved' | 'rejected') => {
    const ok = await act(() => azureBuilderApi.decide(id!, { environment: env, decision, ...(comments.trim() ? { comments: comments.trim() } : {}), ...(decision === 'approved' ? { raiChecklist: rai } : {}) }), 'The decision could not be recorded.');
    if (ok) { setComments(''); setRai([]); }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const latestFor = (e: TargetEnv) => (bundle ? whatIfs.find((w) => w.environment === e && w.iacVersion === bundle.version) ?? null : null);
  const decisionFor = (e: TargetEnv) => (bundle ? approvals.find((a) => a.environment === e && a.iacVersion === bundle.version) ?? null : null);
  const w = latestFor(env);
  const r = w?.report;
  const d = decisionFor(env);
  const stale = !!(state && (state.architectureStale || state.iacStale));
  const raiMissing = r?.raiRequired ? RAI_CHECKLIST.filter((i) => !rai.includes(i.id)) : [];
  const approveBlocked = !w ? 'Run a what-if for this environment first.' : !r!.approvable ? 'The what-if has blocking issues.' : raiMissing.length ? 'Confirm every responsible-AI checklist item.' : null;
  const command = state?.connection
    ? `az deployment group what-if --resource-group ${state.connection.resourceGroup} --template-file infra/main.bicep --parameters infra/params/${env}.bicepparam --no-pretty-print > whatif-${env}.json`
    : '';

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 5" title="Validate & approve" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">{error ?? 'Loading...'}</div>
        ) : !bundle ? (
          <div className="card">Approval is for a specific IaC bundle. Complete <Link to={`/projects/${project.id}/azure-builder/iac`}>Phase 4: Generate IaC</Link> first.</div>
        ) : (
          <>
            {stale && (
              <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--warning)' }}>
                The design changed since bundle v{bundle.version} was generated. <Link to={`/projects/${project.id}/azure-builder/${state.architectureStale ? 'architect' : 'iac'}`}>{state.architectureStale ? 'Design' : 'Generate'} it again</Link> before validating.
              </div>
            )}

            <div className="card" style={{ marginBottom: 16 }} aria-label="Approval target">
              <div className="metric-label" style={{ marginBottom: 8 }}>
                IaC bundle v{bundle.version} · <code>{bundle.root}</code> · hash <code>{short(r?.iacHash ?? '')}{r ? '' : '(computed on the first what-if)'}</code> · architecture v{bundle.architectureVersion} · target {state.connection?.subscriptionId} / {state.connection?.resourceGroup}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist">
                {TARGET_ENVS.map((e) => {
                  const dec = decisionFor(e);
                  const wi = latestFor(e);
                  const label = dec ? dec.decision : wi ? (wi.report.approvable ? 'ready to approve' : 'blocked') : 'not validated';
                  return (
                    <button key={e} type="button" role="tab" aria-selected={env === e} className={`checkbox-chip${env === e ? ' checked' : ''}`} onClick={() => { setEnv(e); setError(null); }}>
                      {e} <span className={`status-pill ${dec?.decision === 'approved' ? 'validated' : dec?.decision === 'rejected' || label === 'blocked' ? 'danger' : label === 'ready to approve' ? 'warning' : ''}`} style={{ marginLeft: 6 }}>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }} aria-label="What-if">
              <div className="metric-label" style={{ marginBottom: 8 }}>What-if for {env}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {state.connection?.source === 'live' && (
                  <label className={`checkbox-chip${source === 'live' ? ' checked' : ''}`}>
                    <input type="radio" name="source" checked={source === 'live'} onChange={() => setSource('live')} /> Live ARM what-if (your Azure sign-in)
                  </label>
                )}
                <label className={`checkbox-chip${source === 'planned' ? ' checked' : ''}`}>
                  <input type="radio" name="source" checked={source === 'planned'} onChange={() => setSource('planned')} /> Offline plan (from the design)
                </label>
                <label className={`checkbox-chip${source === 'arm' ? ' checked' : ''}`}>
                  <input type="radio" name="source" checked={source === 'arm'} onChange={() => setSource('arm')} /> Paste an ARM what-if
                </label>
              </div>
              {source === 'live' ? (
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px' }}>
                  Compiles bundle v{bundle.version} with the {env} parameters and asks Azure what it would change in {state.connection?.resourceGroup}, as you. Nothing is
                  deployed. This is the evidence a deployment from the app (Phase 6) requires; the resource group must already exist.
                </p>
              ) : source === 'planned' ? (
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px' }}>
                  Lists what this bundle creates in {env} and what it only references, and applies the approval rules. It does not call Azure - for evidence from the subscription itself, paste an ARM what-if.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 13, margin: '0 0 6px' }}>Run this with the files from bundle v{bundle.version} (Reader is not enough - what-if needs deployment permission on the resource group), then paste the JSON:</p>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--bg)', padding: 8, borderRadius: 6, margin: '0 0 8px' }}>{command}</pre>
                  <textarea aria-label="ARM what-if output" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{ "status": "Succeeded", "changes": [ ... ] }' style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
                </>
              )}
              {signInNeeded && <button type="button" className="primary-btn" style={{ marginRight: 8 }} onClick={() => signInToAzure().catch((e) => setError(azureErrorText(e, 'Could not start the Azure sign-in.')))}>Sign in to Azure</button>}
              <button className="primary-btn" type="button" disabled={busy || stale || (source === 'arm' && !pasted.trim())} onClick={onWhatIf}>{busy ? (source === 'live' ? 'Asking Azure (up to a few minutes)...' : 'Running...') : `Run what-if for ${env}`}</button>
            </div>

            {w && r && (
              <>
                <div className="card" style={{ marginBottom: 16 }} aria-label="Validation report">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                    <span className={`status-pill ${r.approvable ? 'validated' : 'danger'}`}>{r.approvable ? 'Approvable' : 'Blocked'}</span>
                    <span className="status-pill">{r.source === 'arm' ? (r.armOrigin === 'live' ? 'Live ARM what-if' : 'Pasted ARM what-if') : 'Offline plan'}</span>
                    {(['Create', 'Modify', 'Delete', 'NoChange'] as ChangeType[]).map((t) => <span key={t} className={`status-pill ${r.counts[t] ? CHANGE_PILL[t] : ''}`}>{t} {r.counts[t]}</span>)}
                    <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{new Date(w.createdAt).toLocaleString()} · hash {short(w.iacHash)}</span>
                  </div>
                  <div className="card-grid">
                    <div className="card"><div className="metric-label">Estimated monthly cost ({env})</div><div className="metric-value">{usd(r.monthlyUsd)}</div>{r.budgetUsd != null && <div style={{ fontSize: 11, color: r.monthlyUsd > r.budgetUsd ? 'var(--danger)' : 'var(--muted)' }}>budget {usd(r.budgetUsd)}</div>}</div>
                    <div className="card"><div className="metric-label">Risk class</div><div className="metric-value" style={{ fontSize: 20 }}>{r.riskClass}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.raiRequired ? 'responsible-AI checklist required' : 'no checklist required'}</div></div>
                    <div className="card"><div className="metric-label">Bicep</div><div className="metric-value" style={{ fontSize: 20 }}>{r.compile.status}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.compile.tool ?? 'not compiled on the server'}</div></div>
                  </div>
                  {r.blocking.length > 0 && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10, color: 'var(--danger)' }}>Blocking - approval is not possible until these are fixed</div>
                      <ul style={{ fontSize: 13, margin: '4px 0 0', paddingLeft: 18 }}>{r.blocking.map((b) => <li key={b}>{b}</li>)}</ul>
                    </>
                  )}
                  {r.risks.length > 0 && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10, color: 'var(--warning)' }}>Risks for the approver</div>
                      <ul style={{ fontSize: 13, margin: '4px 0 0', paddingLeft: 18 }}>{r.risks.map((x) => <li key={x}>{x}</li>)}</ul>
                    </>
                  )}
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{w.changes.length} changes</summary>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }} aria-label="Changes">
                      <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}><th style={cell}>Change</th><th style={cell}>Type</th><th style={cell}>Name</th><th style={cell}>Owner</th><th style={cell}>Location</th><th style={cell}>Note</th></tr>
                      </thead>
                      <tbody>
                        {w.changes.map((c) => (
                          <tr key={c.resourceId + c.changeType} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={cell}><span className={`status-pill ${CHANGE_PILL[c.changeType]}`}>{c.changeType}</span></td>
                            <td style={cell}>{c.type.replace(/^Microsoft\./, '')}</td>
                            <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{c.name}</td>
                            <td style={cell}>{c.owned ? 'this use case' : 'shared / other'}</td>
                            <td style={cell}>{c.location ?? '-'}</td>
                            <td style={{ ...cell, color: 'var(--muted)' }}>{c.note ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>

                <div className="card" style={{ marginBottom: 16 }} aria-label="Decision">
                  <div className="metric-label" style={{ marginBottom: 8 }}>
                    Decision for {env} on bundle v{bundle.version}{d ? ` - currently ${d.decision} by ${d.approverEmail}` : ''}
                  </div>
                  {r.raiRequired && (
                    <div style={{ marginBottom: 10 }} aria-label="Responsible AI checklist">
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Responsible-AI checklist (high-risk use case)</div>
                      {RAI_CHECKLIST.map((i) => (
                        <label key={i.id} style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 4, alignItems: 'flex-start' }}>
                          <input type="checkbox" checked={rai.includes(i.id)} onChange={(e) => setRai(e.target.checked ? [...rai, i.id] : rai.filter((x) => x !== i.id))} style={{ marginTop: 3 }} />
                          {i.text}
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="comments">Comments (required to reject)</label>
                    <textarea id="comments" rows={2} value={comments} onChange={(e) => setComments(e.target.value)} style={{ width: '100%' }} />
                  </div>
                  {env === 'prod' && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>Separation of duties: the person who generated this bundle cannot approve it for production.</p>}
                  {error && <div className="error-text">{error}</div>}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="primary-btn" type="button" disabled={busy || stale || !!approveBlocked} onClick={() => onDecide('approved')}>Approve {env}</button>
                    <button className="secondary-btn" type="button" disabled={busy || stale} onClick={() => onDecide('rejected')}>Reject</button>
                    {approveBlocked && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{approveBlocked}</span>}
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>
                    A decision is permanent and bound to hash {short(w.iacHash)}: a deployment of any other bytes will be refused. A new decision is recorded as a new entry.
                  </p>
                </div>
              </>
            )}
            {!w && error && <div className="card error-text" style={{ marginBottom: 16 }}>{error}</div>}

            {approvals.length > 0 && (
              <div className="card" aria-label="Approval history">
                <div className="metric-label" style={{ marginBottom: 6 }}>Decisions (immutable)</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}><th style={cell}>When</th><th style={cell}>Env</th><th style={cell}>Decision</th><th style={cell}>By</th><th style={cell}>Bundle</th><th style={cell}>Hash</th><th style={cell}>Evidence</th><th style={cell}>Comments</th></tr>
                  </thead>
                  <tbody>
                    {approvals.map((a) => (
                      <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={cell}>{new Date(a.createdAt).toLocaleString()}</td>
                        <td style={cell}>{a.environment}</td>
                        <td style={cell}><span className={`status-pill ${a.decision === 'approved' ? 'validated' : 'danger'}`}>{a.decision}</span></td>
                        <td style={cell}>{a.approverEmail}</td>
                        <td style={cell}>v{a.iacVersion}</td>
                        <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{short(a.iacHash)}</td>
                        <td style={cell}>{a.evidence === 'arm-what-if' ? 'ARM what-if' : 'offline plan'}{a.raiChecklist.length ? ` · RAI ${a.raiChecklist.length}/${RAI_CHECKLIST.length}` : ''}</td>
                        <td style={cell}>{a.comments ?? ''}</td>
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
