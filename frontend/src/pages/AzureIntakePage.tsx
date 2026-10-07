import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import {
  AzureBuilderState,
  AzureUseCase,
  azureBuilderApi,
  Channel,
  DataSourceSpec,
  IntakeAnswers,
  PatternInfo,
  REGIONS,
  SolutionPattern,
} from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const STEPS = ['Business', 'Users & volume', 'Data', 'Constraints', 'Review'];
const CHANNELS: Channel[] = ['web', 'teams', 'mobile', 'api', 'email'];
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
const cell = { padding: '6px 8px', verticalAlign: 'top' as const };
const RISK_PILL = { low: 'validated', medium: 'warning', high: 'danger' } as const;

const EMPTY: IntakeAnswers = {
  name: '',
  business: { problem: '', kpis: [], sponsor: '', costCenter: '' },
  users: { type: 'internal', count: 0, peakConcurrent: 0, channels: [] },
  data: [],
  constraints: { regions: [], dataResidency: null, compliance: [], latencyMs: null, availability: null, monthlyBudgetUsd: null },
  environment: 'dev',
};
const NEW_SOURCE: DataSourceSpec = { source: '', format: '', volumeGb: 0, classification: 'internal', containsPersonalData: false, refresh: 'daily' };

/** The answers part of a stored spec (drops the classifier's pattern block and the owner). */
function answersOf(u: AzureUseCase): IntakeAnswers {
  const { pattern: _pattern, owner: _owner, ...answers } = u.spec;
  return answers;
}

/** Azure AI Factory Builder - Phase 2 (Use case intake): a guided wizard that produces a classified UseCaseSpec. */
export function AzureIntakePage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [history, setHistory] = useState<AzureUseCase[]>([]);
  const [patterns, setPatterns] = useState<PatternInfo[]>([]);
  const [answers, setAnswers] = useState<IntakeAnswers>(EMPTY);
  // List fields are edited as text and split on submit, so typing a comma or a new line is not swallowed.
  const [kpiText, setKpiText] = useState('');
  const [complianceText, setComplianceText] = useState('');
  const [sources, setSources] = useState<Record<string, string> | null>(null);
  const [step, setStep] = useState(0);
  const [override, setOverride] = useState<{ pattern: SolutionPattern | ''; reason: string }>({ pattern: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fill = (a: IntakeAnswers) => {
    setAnswers(a);
    setKpiText(a.business.kpis.join('\n'));
    setComplianceText(a.constraints.compliance.join(', '));
  };

  const load = async (initial = false) => {
    if (!id) return;
    const [s, h, pre] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.useCases(id), azureBuilderApi.intakePrefill(id)]);
    setState(s);
    setHistory(h);
    setPatterns(pre.patterns);
    if (initial) {
      if (s.useCase) fill(answersOf(s.useCase));
      else {
        fill(pre.answers);
        setSources(pre.sources);
      }
    }
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load(true).catch((err) => setError(extractErrorMessage(err, 'Could not load the use case intake.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  const onPrefill = async () => {
    if (!id) return;
    setError(null);
    try {
      const pre = await azureBuilderApi.intakePrefill(id);
      fill(pre.answers);
      setSources(pre.sources);
      setStep(0);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not read the Evectorize project.'));
    }
  };

  const setBusiness = (patch: Partial<IntakeAnswers['business']>) => setAnswers({ ...answers, business: { ...answers.business, ...patch } });
  const setUsers = (patch: Partial<IntakeAnswers['users']>) => setAnswers({ ...answers, users: { ...answers.users, ...patch } });
  const setConstraints = (patch: Partial<IntakeAnswers['constraints']>) => setAnswers({ ...answers, constraints: { ...answers.constraints, ...patch } });
  const setSource = (i: number, patch: Partial<DataSourceSpec>) => setAnswers({ ...answers, data: answers.data.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  const final = (): IntakeAnswers => ({
    ...answers,
    business: { ...answers.business, kpis: lines(kpiText) },
    constraints: { ...answers.constraints, compliance: list(complianceText) },
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    const unnamed = answers.data.findIndex((d) => !d.source.trim());
    if (answers.name.trim().length < 3 || answers.business.problem.trim().length < 3 || unnamed >= 0) {
      setError(unnamed >= 0 ? `Data source ${unnamed + 1} needs a name (step 3), or remove it.` : 'Give the use case a name and a business problem (step 1).');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await azureBuilderApi.submitUseCase(id, final());
      setSources(null);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'Classification failed.'));
    } finally {
      setBusy(false);
    }
  };

  const onOverride = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !override.pattern) return;
    setError(null);
    setBusy(true);
    try {
      await azureBuilderApi.overridePattern(id, { pattern: override.pattern, reason: override.reason.trim() });
      setOverride({ pattern: '', reason: '' });
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'Override failed.'));
    } finally {
      setBusy(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const uc = state?.useCase ?? null;
  const label = (p: SolutionPattern) => patterns.find((x) => x.id === p)?.label ?? p;
  const hint = (key: string) => sources?.[key] && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sources[key]}</div>;
  const a = answers;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 2" title="Use case intake" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">{error ?? 'Loading...'}</div>
        ) : (
          <>
            {uc && (
              <div className="card" style={{ marginBottom: 16 }} aria-label="Classification result">
                <div className="metric-label" style={{ marginBottom: 8 }}>
                  UseCaseSpec v{uc.version} · {uc.spec.name} · {uc.spec.environment} · by {uc.spec.owner} · {new Date(uc.createdAt).toLocaleString()}
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{label(uc.spec.pattern.id)}</div>
                  <span className="status-pill">{Math.round(uc.spec.pattern.confidence * 100)}% confidence</span>
                  <span className={`status-pill ${RISK_PILL[uc.spec.pattern.riskClass]}`}>{uc.spec.pattern.riskClass} risk</span>
                  {uc.spec.pattern.overriddenBy && <span className="status-pill warning">overridden (classified as {label(uc.spec.pattern.classifiedAs)})</span>}
                </div>
                <p style={{ fontSize: 14, margin: '0 0 8px' }}>{uc.spec.pattern.rationale}</p>
                {!uc.spec.pattern.supportedInMvp && (
                  <div style={{ fontSize: 13, borderLeft: '4px solid var(--warning)', padding: '6px 10px', marginBottom: 8 }}>
                    Phase 3 (Architect) designs only the RAG knowledge assistant in this release. This use case is recorded, but its architecture cannot be generated yet.
                  </div>
                )}
                <div style={{ fontSize: 13, marginBottom: 8 }}><strong>Risk:</strong> {uc.classification.riskReasons.join('; ')}</div>
                {uc.spec.pattern.missingInfo.length > 0 && (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Missing information (not guessed - fill these in and re-classify)</div>
                    <ul style={{ fontSize: 13, margin: '4px 0 8px', paddingLeft: 18, color: 'var(--warning)' }}>
                      {uc.spec.pattern.missingInfo.map((m) => <li key={m}>{m}</li>)}
                    </ul>
                  </>
                )}
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>How the classifier scored each pattern ({uc.classification.classifier})</summary>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 6 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}><th style={cell}>Pattern</th><th style={cell}>Score</th><th style={cell}>Evidence</th></tr>
                    </thead>
                    <tbody>
                      {patterns.map((p) => (
                        <tr key={p.id} style={{ borderBottom: '1px solid var(--border)', fontWeight: p.id === uc.classification.pattern ? 600 : 400 }}>
                          <td style={cell}>{p.label}{p.mvp ? '' : ' (later wave)'}</td>
                          <td style={cell}>{uc.classification.scores[p.id]}</td>
                          <td style={cell}>{uc.classification.signals[p.id].join(', ') || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>

                <form onSubmit={onOverride} aria-label="Override form" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div className="metric-label" style={{ marginBottom: 6 }}>Override the pattern (recorded with your name and reason)</div>
                  <div className="field-grid">
                    <div className="field">
                      <label htmlFor="overridePattern">Pattern</label>
                      <select id="overridePattern" value={override.pattern} onChange={(e) => setOverride({ ...override, pattern: e.target.value as SolutionPattern })}>
                        <option value="">Choose...</option>
                        {patterns.filter((p) => p.id !== uc.spec.pattern.id).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="overrideReason">Reason</label>
                      <input id="overrideReason" value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} placeholder="Why the classifier is wrong for this use case" />
                    </div>
                  </div>
                  <button className="primary-btn" type="submit" disabled={busy || !override.pattern || override.reason.trim().length < 10}>Record override (new version)</button>
                </form>
              </div>
            )}

            <form className="card" style={{ marginBottom: 16 }} onSubmit={onSubmit} aria-label="Intake wizard">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                {STEPS.map((s, i) => (
                  <button key={s} type="button" className={`checkbox-chip${i === step ? ' checked' : ''}`} onClick={() => setStep(i)}>
                    {i + 1}. {s}
                  </button>
                ))}
                <button type="button" className="status-pill" style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={onPrefill}>Prefill from Evectorize</button>
              </div>
              {sources && Object.keys(sources).length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                  Prefilled {Object.keys(sources).length} answers from this project, its Azure connection and its Discovery assessment - check each one. Hints show where a value came from.
                </div>
              )}

              {step === 0 && (
                <div className="field-grid">
                  <div className="field"><label htmlFor="ucName">Use case name</label><input id="ucName" value={a.name} onChange={(e) => setAnswers({ ...a, name: e.target.value })} />{hint('name')}</div>
                  <div className="field">
                    <label htmlFor="environment">Target environment</label>
                    <select id="environment" value={a.environment} onChange={(e) => setAnswers({ ...a, environment: e.target.value as IntakeAnswers['environment'] })}>
                      <option value="dev">dev</option><option value="test">test</option><option value="prod">prod</option>
                    </select>
                    {hint('environment')}
                  </div>
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="problem">Business problem (what users do today, and what should change)</label>
                    <textarea id="problem" rows={4} value={a.business.problem} onChange={(e) => setBusiness({ problem: e.target.value })} style={{ width: '100%' }} />
                    {hint('business.problem')}
                  </div>
                  <div className="field"><label htmlFor="kpis">KPIs (one per line, measurable)</label><textarea id="kpis" rows={3} value={kpiText} onChange={(e) => setKpiText(e.target.value)} placeholder="Deflect 30% of HR tickets" style={{ width: '100%' }} /></div>
                  <div className="field"><label htmlFor="sponsor">Business sponsor</label><input id="sponsor" value={a.business.sponsor} onChange={(e) => setBusiness({ sponsor: e.target.value })} /></div>
                  <div className="field"><label htmlFor="costCenter">Cost center (becomes the costCenter tag)</label><input id="costCenter" value={a.business.costCenter} onChange={(e) => setBusiness({ costCenter: e.target.value })} /></div>
                </div>
              )}

              {step === 1 && (
                <>
                  <div className="field-grid">
                    <div className="field">
                      <label htmlFor="userType">Who uses it</label>
                      <select id="userType" value={a.users.type} onChange={(e) => setUsers({ type: e.target.value as IntakeAnswers['users']['type'] })}>
                        <option value="internal">Internal (employees)</option><option value="external">External (customers, partners)</option><option value="mixed">Mixed</option>
                      </select>
                    </div>
                    <div className="field"><label htmlFor="userCount">Total users</label><input id="userCount" type="number" min={0} value={a.users.count} onChange={(e) => setUsers({ count: Number(e.target.value) })} />{hint('users.count')}</div>
                    <div className="field"><label htmlFor="peak">Peak concurrent users</label><input id="peak" type="number" min={0} value={a.users.peakConcurrent} onChange={(e) => setUsers({ peakConcurrent: Number(e.target.value) })} />{hint('users.peakConcurrent')}</div>
                  </div>
                  <div className="metric-label" style={{ margin: '8px 0 6px' }}>Channels</div>
                  <div className="checkbox-grid">
                    {CHANNELS.map((c) => (
                      <label key={c} className={`checkbox-chip${a.users.channels.includes(c) ? ' checked' : ''}`}>
                        <input type="checkbox" checked={a.users.channels.includes(c)} onChange={() => setUsers({ channels: toggle(a.users.channels, c) })} />
                        {c === 'api' ? 'API only' : c[0].toUpperCase() + c.slice(1)}
                      </label>
                    ))}
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  {hint('data')}
                  {a.data.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No data sources yet. Add each system the solution reads from.</p>}
                  {a.data.map((d, i) => (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div className="field-grid">
                        <div className="field"><label htmlFor={`src-${i}`}>Source</label><input id={`src-${i}`} value={d.source} onChange={(e) => setSource(i, { source: e.target.value })} placeholder="SharePoint HR site" /></div>
                        <div className="field"><label htmlFor={`fmt-${i}`}>Format</label><input id={`fmt-${i}`} value={d.format} onChange={(e) => setSource(i, { format: e.target.value })} placeholder="pdf/docx, scanned tiff, sql tables" /></div>
                        <div className="field"><label htmlFor={`vol-${i}`}>Volume (GB)</label><input id={`vol-${i}`} type="number" min={0} step="any" value={d.volumeGb} onChange={(e) => setSource(i, { volumeGb: Number(e.target.value) })} /></div>
                        <div className="field">
                          <label htmlFor={`cls-${i}`}>Classification</label>
                          <select id={`cls-${i}`} value={d.classification} onChange={(e) => setSource(i, { classification: e.target.value as DataSourceSpec['classification'] })}>
                            {['public', 'internal', 'confidential', 'restricted'].map((x) => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor={`ref-${i}`}>Refresh</label>
                          <select id={`ref-${i}`} value={d.refresh} onChange={(e) => setSource(i, { refresh: e.target.value as DataSourceSpec['refresh'] })}>
                            {['static', 'weekly', 'daily', 'hourly', 'realtime'].map((x) => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <label className={`checkbox-chip${d.containsPersonalData ? ' checked' : ''}`}>
                          <input type="checkbox" checked={d.containsPersonalData} onChange={(e) => setSource(i, { containsPersonalData: e.target.checked })} />
                          Contains personal data
                        </label>
                        <button type="button" className="status-pill" style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={() => setAnswers({ ...a, data: a.data.filter((_, j) => j !== i) })}>Remove</button>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="status-pill" style={{ cursor: 'pointer', marginBottom: 12 }} onClick={() => setAnswers({ ...a, data: [...a.data, { ...NEW_SOURCE }] })}>+ Add data source</button>
                </>
              )}

              {step === 3 && (
                <>
                  <div className="metric-label" style={{ marginBottom: 6 }}>Allowed regions</div>
                  {hint('constraints.regions')}
                  <div className="checkbox-grid" style={{ marginBottom: 10 }}>
                    {REGIONS.map((r) => (
                      <label key={r.value} className={`checkbox-chip${a.constraints.regions.includes(r.value) ? ' checked' : ''}`}>
                        <input type="checkbox" checked={a.constraints.regions.includes(r.value)} onChange={() => setConstraints({ regions: toggle(a.constraints.regions, r.value) })} />
                        {r.label}
                      </label>
                    ))}
                  </div>
                  <div className="field-grid">
                    <div className="field"><label htmlFor="residency">Data residency (country or region, optional)</label><input id="residency" value={a.constraints.dataResidency ?? ''} onChange={(e) => setConstraints({ dataResidency: e.target.value.trim() ? e.target.value : null })} placeholder="IN" />{hint('constraints.dataResidency')}</div>
                    <div className="field"><label htmlFor="compliance">Compliance (comma-separated)</label><input id="compliance" value={complianceText} onChange={(e) => setComplianceText(e.target.value)} placeholder="DPDP, ISO 27001" />{hint('constraints.compliance')}</div>
                    <div className="field"><label htmlFor="latency">Target response time (ms)</label><input id="latency" type="number" min={1} value={a.constraints.latencyMs ?? ''} onChange={(e) => setConstraints({ latencyMs: numOrNull(e.target.value) })} />{hint('constraints.latencyMs')}</div>
                    <div className="field"><label htmlFor="availability">Availability target (%)</label><input id="availability" value={a.constraints.availability ?? ''} onChange={(e) => setConstraints({ availability: e.target.value.trim() || null })} placeholder="99.9" />{hint('constraints.availability')}</div>
                    <div className="field"><label htmlFor="budget">Monthly budget (USD)</label><input id="budget" type="number" min={0} value={a.constraints.monthlyBudgetUsd ?? ''} onChange={(e) => setConstraints({ monthlyBudgetUsd: numOrNull(e.target.value) })} />{hint('constraints.monthlyBudgetUsd')}</div>
                  </div>
                </>
              )}

              {step === 4 && (
                <div style={{ fontSize: 13 }} aria-label="Review">
                  <p style={{ margin: '0 0 6px' }}><strong>{a.name || '(no name)'}</strong> · {a.environment}</p>
                  <p style={{ margin: '0 0 6px' }}>{a.business.problem || '(no problem statement)'}</p>
                  <p style={{ margin: '0 0 6px' }}>KPIs: {lines(kpiText).join('; ') || '-'} · Sponsor: {a.business.sponsor || '-'} · Cost center: {a.business.costCenter || '-'}</p>
                  <p style={{ margin: '0 0 6px' }}>Users: {a.users.type}, {a.users.count.toLocaleString()} total, {a.users.peakConcurrent.toLocaleString()} peak · Channels: {a.users.channels.join(', ') || '-'}</p>
                  <p style={{ margin: '0 0 6px' }}>Data: {a.data.map((d) => `${d.source || '?'} (${d.format || '?'}, ${d.volumeGb} GB, ${d.classification}${d.containsPersonalData ? ', personal data' : ''})`).join('; ') || '-'}</p>
                  <p style={{ margin: '0 0 6px' }}>
                    Regions: {a.constraints.regions.join(', ') || '-'} · Residency: {a.constraints.dataResidency || '-'} · Compliance: {list(complianceText).join(', ') || '-'} ·
                    Latency: {a.constraints.latencyMs ?? '-'} ms · Availability: {a.constraints.availability ?? '-'}% · Budget: {a.constraints.monthlyBudgetUsd != null ? `$${a.constraints.monthlyBudgetUsd.toLocaleString()}/month` : '-'}
                  </p>
                  <p style={{ margin: '8px 0 0', color: 'var(--muted)' }}>Classifying picks a solution pattern, a risk class and lists any missing information. Each run saves a new version.</p>
                </div>
              )}

              {error && <div className="error-text">{error}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                {step > 0 && <button type="button" className="secondary-btn" onClick={() => setStep(step - 1)}>Back</button>}
                <button className="primary-btn" type="submit" disabled={busy}>
                  {step < STEPS.length - 1 ? 'Next' : busy ? 'Classifying...' : uc ? 'Re-classify (new version)' : 'Classify use case'}
                </button>
              </div>
            </form>

            {history.length > 1 && (
              <div className="card">
                <div className="metric-label" style={{ marginBottom: 6 }}>Previous versions</div>
                <ul style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>
                  {history.map((h) => (
                    <li key={h.id}>
                      v{h.version} · {label(h.spec.pattern.id)} · {Math.round(h.spec.pattern.confidence * 100)}% · {h.spec.pattern.riskClass} risk
                      {h.spec.pattern.overriddenBy ? ` · override by ${h.spec.pattern.overriddenBy}` : ''} · {new Date(h.createdAt).toLocaleString()}
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
