import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorDetails, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { AzureBuilderState, AzureIacBundle, azureBuilderApi, IacDiagnostic } from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const STATUS_PILL = { passed: 'validated', failed: 'danger', skipped: 'warning' } as const;
const cell = { padding: '6px 8px', verticalAlign: 'top' as const };
const WORKLOAD_RE = /^[a-z][a-z0-9]{1,11}$/;

function DiagnosticsTable({ items }: { items: IacDiagnostic[] }) {
  if (!items.length) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}><th style={cell}>Level</th><th style={cell}>Where</th><th style={cell}>Rule</th><th style={cell}>Message</th></tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={`${d.file}:${d.line}:${d.column}:${d.code}`} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cell}><span className={`status-pill ${d.level === 'error' ? 'danger' : d.level === 'warning' ? 'warning' : ''}`}>{d.level}</span></td>
            <td style={{ ...cell, fontFamily: 'var(--font-mono)' }}>{d.file}:{d.line}</td>
            <td style={cell}>{d.code}</td>
            <td style={cell}>{d.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Azure AI Factory Builder - Phase 4 (Generate IaC): Bicep from Azure Verified Modules, parameters per environment, pipeline and docs. */
export function AzureIacPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [history, setHistory] = useState<AzureIacBundle[]>([]);
  const [workload, setWorkload] = useState('');
  const [openFile, setOpenFile] = useState('infra/main.bicep');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<IacDiagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async (initial = false) => {
    if (!id) return;
    const [s, h] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.iacBundles(id)]);
    setState(s);
    setHistory(h);
    if (initial && h[0]) setWorkload(h[0].workload);
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load(true).catch((err) => setError(extractErrorMessage(err, 'Could not load the infrastructure code.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  const onGenerate = async () => {
    if (!id) return;
    setError(null);
    setFailed([]);
    setBusy(true);
    try {
      const b = await azureBuilderApi.generateIac(id, workload.trim() ? { workload: workload.trim() } : {});
      setWorkload(b.workload);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'The infrastructure code could not be generated.'));
      setFailed(extractErrorDetails<{ diagnostics: IacDiagnostic[] }>(err)?.diagnostics ?? []);
    } finally {
      setBusy(false);
    }
  };

  const onDownload = async (b: AzureIacBundle) => {
    if (!id) return;
    try {
      const blob = await azureBuilderApi.downloadIac(id, b.version);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${b.root}-v${b.version}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not download the bundle.'));
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const bundle = history[0] ?? null;
  const file = bundle?.files.find((f) => f.path === openFile) ?? bundle?.files[0] ?? null;
  const v = bundle?.validation;
  const workloadInvalid = workload.trim() !== '' && !WORKLOAD_RE.test(workload.trim());

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 4" title="Generate IaC" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">{error ?? 'Loading...'}</div>
        ) : !state.architecture ? (
          <div className="card">The infrastructure code is generated from the architecture. Complete <Link to={`/projects/${project.id}/azure-builder/architect`}>Phase 3: Architect</Link> first.</div>
        ) : (
          <>
            {state.architectureStale && (
              <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--warning)' }}>
                The use case or the Environment Profile changed since the architecture was designed. <Link to={`/projects/${project.id}/azure-builder/architect`}>Design it again</Link> before generating.
              </div>
            )}
            {!state.architectureStale && state.iacStale && (
              <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--warning)' }}>
                The architecture changed since this bundle (bundle from architecture v{bundle?.architectureVersion}; now v{state.architecture.version}). Generate again.
              </div>
            )}

            <div className="card" style={{ marginBottom: 16 }} aria-label="Generate options">
              <div className="metric-label" style={{ marginBottom: 8 }}>
                Generate Bicep for ArchitectureSpec v{state.architecture.version} · {state.architecture.spec.useCaseName} · {state.architecture.spec.region} · {state.architecture.spec.components.length} components
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="workload">Workload name in resource names (CAF: &lt;type&gt;-&lt;workload&gt;-&lt;env&gt;-&lt;region&gt;-&lt;instance&gt;)</label>
                  <input id="workload" value={workload} onChange={(e) => setWorkload(e.target.value.toLowerCase())} placeholder="derived from the use case name" maxLength={12} />
                  {workloadInvalid && <div className="error-text">2-12 lower-case letters and digits, starting with a letter.</div>}
                </div>
              </div>
              {error && <div className="error-text">{error}</div>}
              <DiagnosticsTable items={failed} />
              <button className="primary-btn" type="button" disabled={busy || workloadInvalid || state.architectureStale} onClick={onGenerate} style={{ marginTop: 8 }}>
                {busy ? 'Generating and compiling...' : bundle ? 'Generate again (new version)' : 'Generate infrastructure code'}
              </button>
            </div>

            {bundle && v && (
              <>
                <div className="card" style={{ marginBottom: 16 }} aria-label="Bundle summary">
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                    <div className="metric-label">Bundle v{bundle.version} · <code>{bundle.root}</code> · from architecture v{bundle.architectureVersion} · {bundle.generator} · {new Date(bundle.createdAt).toLocaleString()}</div>
                    <button type="button" className="secondary-btn" style={{ marginLeft: 'auto' }} onClick={() => onDownload(bundle)}>Download .zip</button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} aria-label="Validation">
                    <span className={`status-pill ${STATUS_PILL[v.status]}`}>Bicep {v.status === 'passed' ? 'compiles' : v.status}</span>
                    {v.tool && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v.tool} · {v.diagnostics.filter((d) => d.level === 'warning').length} warning(s) · {v.commands.length} checks</span>}
                    {v.reason && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v.reason}</span>}
                  </div>
                  {v.commands.length > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>{v.commands.join(' · ')}</div>}
                  <DiagnosticsTable items={v.diagnostics.filter((d) => d.level !== 'info')} />
                </div>

                <div className="card" style={{ marginBottom: 16 }} aria-label="Required inputs">
                  <div className="metric-label" style={{ marginBottom: 6 }}>What the generator did not invent - fill these in</div>
                  {(['before-deploy', 'after-deploy'] as const).map((when) => {
                    const items = bundle.requiredInputs.filter((r) => r.when === when);
                    return items.length ? (
                      <div key={when} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{when === 'before-deploy' ? 'Before deploying' : 'After deploying'}</div>
                        <ul style={{ fontSize: 13, margin: '4px 0 0', paddingLeft: 18 }}>
                          {items.map((r) => <li key={r.name}><strong>{r.name}</strong> <span style={{ color: 'var(--muted)' }}>({r.where})</span> - {r.description}</li>)}
                        </ul>
                      </div>
                    ) : null;
                  })}
                  {bundle.notes.length > 0 && (
                    <ul style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18, color: 'var(--muted)' }}>
                      {bundle.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                </div>

                <div className="card" style={{ marginBottom: 16 }} aria-label="Files">
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flex: '0 0 280px', minWidth: 0 }}>
                      <div className="metric-label" style={{ marginBottom: 6 }}>{bundle.root}/</div>
                      {bundle.files.map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => { setOpenFile(f.path); setCopied(false); }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', marginBottom: 2, borderRadius: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
                            fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)', background: file?.path === f.path ? 'var(--card)' : 'transparent',
                            border: `1px solid ${file?.path === f.path ? 'var(--primary-text)' : 'transparent'}`,
                          }}
                        >
                          {f.path} <span style={{ color: 'var(--muted)' }}>· {f.content.split('\n').length}</span>
                        </button>
                      ))}
                    </div>
                    {file && (
                      <div style={{ flex: '1 1 480px', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <code style={{ fontSize: 12 }}>{file.path}</code>
                          <button type="button" className="status-pill" style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={() => { navigator.clipboard?.writeText(file.content); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
                        </div>
                        <pre style={{ fontSize: 11.5, lineHeight: 1.45, background: 'var(--bg)', padding: 10, borderRadius: 6, margin: 0, maxHeight: 560, overflow: 'auto', whiteSpace: 'pre' }} aria-label="File content">{file.content}</pre>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {history.length > 1 && (
              <div className="card">
                <div className="metric-label" style={{ marginBottom: 6 }}>Previous versions</div>
                <ul style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>
                  {history.map((h) => (
                    <li key={h.id}>
                      v{h.version} · architecture v{h.architectureVersion} · workload {h.workload} · Bicep {h.validation.status} · {h.files.length} files · {new Date(h.createdAt).toLocaleString()}{' '}
                      <button type="button" className="status-pill" style={{ cursor: 'pointer' }} onClick={() => onDownload(h)}>zip</button>
                    </li>
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
