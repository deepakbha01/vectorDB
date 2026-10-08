import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useFeatures } from '../api/features';
import { ArchitectureOptions, ArchitectureSpec, AzureArchitecture, AzureBuilderState, azureBuilderApi, ConnectionKind, Zone } from '../api/azureBuilder';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const ZONES: Array<{ id: Zone; label: string }> = [
  { id: 'edge', label: 'Entry' },
  { id: 'app', label: 'Application' },
  { id: 'ai', label: 'AI models' },
  { id: 'data', label: 'Data and secrets' },
  { id: 'network', label: 'Network' },
  { id: 'monitoring', label: 'Monitoring' },
];

/** How each connection kind is drawn; `minor` kinds are hidden unless "show all links" is on. */
const KIND_STYLE: Record<ConnectionKind, { color: string; dash?: string; label: string; minor?: boolean }> = {
  https: { color: 'var(--primary-text)', label: 'HTTPS (Entra ID)' },
  'private-endpoint': { color: 'var(--cyan)', label: 'Private endpoint' },
  'shared-private-link': { color: 'var(--cyan)', dash: '6 3', label: 'Shared private link' },
  indexer: { color: 'var(--violet)', label: 'Indexer' },
  identity: { color: 'var(--violet)', dash: '4 3', label: 'Managed identity' },
  'hosted-in': { color: 'var(--muted)', dash: '2 3', label: 'Hosted in' },
  peering: { color: 'var(--warning)', label: 'VNet peering' },
  subnet: { color: 'var(--warning)', dash: '4 3', label: 'Subnet', minor: true },
  'dns-zone': { color: 'var(--warning)', dash: '2 3', label: 'DNS zone link', minor: true },
  telemetry: { color: 'var(--muted)', dash: '4 3', label: 'Telemetry', minor: true },
  workspace: { color: 'var(--muted)', dash: '4 3', label: 'Workspace', minor: true },
  diagnostics: { color: 'var(--muted)', dash: '2 4', label: 'Diagnostics', minor: true },
};

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const cell = { padding: '6px 8px', verticalAlign: 'top' as const };
const OPTION_DEFAULTS: ArchitectureOptions = { apiGateway: null, chatHistory: false, deployment: 'auto' };

interface Line { key: string; d: string; kind: ConnectionKind }

/**
 * Draws the ArchitectureSpec: one box per component, grouped by zone, one line
 * per connection. It reads nothing but the spec, so the diagram and the spec
 * cannot disagree (spec 4.4 acceptance).
 */
function ArchitectureDiagram({ spec, selected, onSelect, showAll }: { spec: ArchitectureSpec; selected: string | null; onSelect: (id: string) => void; showAll: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const zones = ZONES.filter((z) => spec.components.some((c) => c.zone === z.id));

  useLayoutEffect(() => {
    const draw = () => {
      const root = wrap.current;
      if (!root) return;
      const base = root.getBoundingClientRect();
      const box = (id: string) => root.querySelector<HTMLElement>(`[data-component="${id}"]`)?.getBoundingClientRect();
      const out: Line[] = [];
      spec.connections.forEach((c, i) => {
        if (!showAll && KIND_STYLE[c.kind]?.minor) return;
        const a = box(c.from);
        const b = box(c.to);
        if (!a || !b) return;
        const ax = a.left - base.left, ay = a.top - base.top + a.height / 2;
        const bx = b.left - base.left, by = b.top - base.top + b.height / 2;
        let d: string;
        if (Math.abs(ax - bx) < 4) {
          // same column: leave and re-enter on the right, bowing outwards
          const x = ax + a.width;
          const bow = 26 + (i % 3) * 8;
          d = `M ${x} ${ay} C ${x + bow} ${ay}, ${x + bow} ${by}, ${x} ${by}`;
        } else {
          const right = bx > ax;
          const x1 = right ? ax + a.width : ax;
          const x2 = right ? bx : bx + b.width;
          const mid = (x1 + x2) / 2;
          d = `M ${x1} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${x2} ${by}`;
        }
        out.push({ key: `${c.from}-${c.to}-${c.kind}`, d, kind: c.kind });
      });
      setLines(out);
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [spec, showAll]);

  return (
    <div ref={wrap} style={{ position: 'relative', overflowX: 'auto' }} aria-label="Architecture diagram">
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${zones.length}, minmax(118px, 1fr))`, gap: 30, position: 'relative', zIndex: 1, minWidth: zones.length * 148 }}>
        {zones.map((z) => (
          <div key={z.id} style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '8px 8px 4px' }}>
            <div className="metric-label" style={{ marginBottom: 8 }}>{z.label}</div>
            {spec.components.filter((c) => c.zone === z.id).map((c) => (
              <button
                key={c.id}
                type="button"
                data-component={c.id}
                onClick={() => onSelect(c.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', marginBottom: 12, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                  background: 'var(--card)', color: 'var(--text)', font: 'inherit', fontSize: 12,
                  border: `${selected === c.id ? 2 : 1}px ${c.reuseExisting ? 'dashed' : 'solid'} ${selected === c.id ? 'var(--primary-text)' : 'var(--border)'}`,
                }}
              >
                <div style={{ fontWeight: 600 }}>{c.label}</div>
                <div style={{ color: 'var(--muted)', fontSize: 11 }}>{c.reuseExisting ? 'existing - reused' : c.optional ? 'optional' : c.type}</div>
              </button>
            ))}
          </div>
        ))}
      </div>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2, overflow: 'visible' }}>
        {lines.map((l) => (
          <path key={l.key} d={l.d} fill="none" stroke={KIND_STYLE[l.kind].color} strokeWidth={1.6} strokeDasharray={KIND_STYLE[l.kind].dash} opacity={0.85} />
        ))}
      </svg>
    </div>
  );
}

/** Azure AI Factory Builder - Phase 3 (Architect): rules-engine design, diagram, cost estimate and ADR drafts. */
export function AzureArchitectPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const [project, setProject] = useState<Project | null>(null);
  const [state, setState] = useState<AzureBuilderState | null>(null);
  const [history, setHistory] = useState<AzureArchitecture[]>([]);
  const [options, setOptions] = useState<ArchitectureOptions>(OPTION_DEFAULTS);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (initial = false) => {
    if (!id) return;
    const [s, h] = await Promise.all([azureBuilderApi.state(id), azureBuilderApi.architectures(id)]);
    setState(s);
    setHistory(h);
    if (initial && s.architecture) setOptions(s.architecture.spec.options);
  };

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
  }, [id]);

  useEffect(() => {
    if (features.azureBuilder) load(true).catch((err) => setError(extractErrorMessage(err, 'Could not load the architecture.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, features.azureBuilder]);

  const onDesign = async () => {
    if (!id) return;
    setError(null);
    setBusy(true);
    try {
      await azureBuilderApi.generateArchitecture(id, options);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'The architecture could not be designed.'));
    } finally {
      setBusy(false);
    }
  };

  if (!project) return <div className="main-content">Loading...</div>;
  const arch = state?.architecture ?? null;
  const spec = arch?.spec ?? null;
  const sel = spec?.components.find((c) => c.id === selected) ?? null;
  const p = (path: string) => `/projects/${project.id}/azure-builder/${path}`;
  const missing = state && (!state.useCase ? ['intake', 'Phase 2: Use case intake'] : !state.connection ? ['connect', 'Phase 0: Connect'] : !state.environmentProfile ? ['discover', 'Phase 1: Discover'] : null);

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar eyebrow="Azure Builder · Phase 3" title="Architect" />
        {!features.azureBuilder ? (
          <div className="card">The Azure AI Factory Builder is not enabled on this server (<code>AZURE_BUILDER_ENABLED</code>).</div>
        ) : !state ? (
          <div className="card">{error ?? 'Loading...'}</div>
        ) : missing ? (
          <div className="card">The architecture is designed from the use case and the target environment. Complete <Link to={p(missing[0])}>{missing[1]}</Link> first.</div>
        ) : (
          <>
            {state.architectureStale && (
              <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--warning)' }}>
                The use case or the Environment Profile changed since this design (it used use case v{arch?.useCaseVersion} and profile v{arch?.profileVersion}; now v{state.useCase?.version} and v{state.environmentProfile?.version}). Design again.
              </div>
            )}

            <div className="card" style={{ marginBottom: 16 }} aria-label="Architecture options">
              <div className="metric-label" style={{ marginBottom: 8 }}>
                Design for {state.useCase!.spec.name} (use case v{state.useCase!.version}, {state.useCase!.spec.environment}) in the environment from Discover v{state.environmentProfile!.version}
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="apiGateway">AI gateway (API Management)</label>
                  <select id="apiGateway" value={options.apiGateway === null ? 'auto' : options.apiGateway ? 'on' : 'off'} onChange={(e) => setOptions({ ...options, apiGateway: e.target.value === 'auto' ? null : e.target.value === 'on' })}>
                    <option value="auto">Let the rules decide (on for external users)</option><option value="on">On</option><option value="off">Off</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="deployment">Model deployment</label>
                  <select id="deployment" value={options.deployment} onChange={(e) => setOptions({ ...options, deployment: e.target.value as ArchitectureOptions['deployment'] })}>
                    <option value="auto">Let the rules decide (PTU above the capacity threshold)</option><option value="payg">Pay-as-you-go</option><option value="ptu">Provisioned throughput (PTU)</option>
                  </select>
                </div>
              </div>
              <div className="checkbox-grid">
                <label className={`checkbox-chip${options.chatHistory ? ' checked' : ''}`}>
                  <input type="checkbox" checked={options.chatHistory} onChange={(e) => setOptions({ ...options, chatHistory: e.target.checked })} />
                  Store chat history (Cosmos DB)
                </label>
              </div>
              {error && <div className="error-text">{error}</div>}
              <button className="primary-btn" type="button" disabled={busy} onClick={onDesign}>{busy ? 'Designing...' : spec ? 'Re-design with these options (new version)' : 'Design architecture'}</button>
            </div>

            {spec && (
              <>
                <div className="card" style={{ marginBottom: 16 }} aria-label="Architecture summary">
                  <div className="metric-label" style={{ marginBottom: 8 }}>
                    ArchitectureSpec v{arch!.version} · {spec.region} · {spec.private ? 'private' : 'public'} · rules {spec.generator.rules} · {new Date(arch!.createdAt).toLocaleString()}
                  </div>
                  <p style={{ fontSize: 14, margin: '0 0 12px' }}>{spec.summary}</p>
                  <div className="card-grid">
                    <div className="card"><div className="metric-label">Estimated monthly cost</div><div className="metric-value">{usd(spec.cost.monthlyUsd)}</div>
                      {spec.cost.budgetUsd != null && <div style={{ fontSize: 11, color: spec.cost.overBudget ? 'var(--danger)' : 'var(--muted)' }}>budget {usd(spec.cost.budgetUsd)}{spec.cost.overBudget ? ' - over' : ''}</div>}</div>
                    <div className="card"><div className="metric-label">One-time (first index)</div><div className="metric-value">{usd(spec.cost.oneTimeUsd)}</div></div>
                    <div className="card"><div className="metric-label">Components</div><div className="metric-value">{spec.components.length}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{spec.components.filter((c) => c.reuseExisting).length} reused</div></div>
                    <div className="card"><div className="metric-label">Chat model</div><div className="metric-value" style={{ fontSize: 18 }}>{spec.sizing.deploymentSku}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{spec.sizing.deploymentSku === 'ProvisionedManaged' ? `${spec.sizing.deploymentCapacity} PTU` : `${fmt(spec.sizing.deploymentCapacity)}K TPM`} · peak ~{fmt(spec.sizing.peakTpm)} TPM</div></div>
                    <div className="card"><div className="metric-label">AI Search</div><div className="metric-value" style={{ fontSize: 18 }}>{spec.sizing.searchTier}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{spec.sizing.searchReplicas} replica(s) x {spec.sizing.searchPartitions} partition(s) · ~{spec.sizing.indexGb} GB</div></div>
                  </div>
                  {spec.warnings.length > 0 && (
                    <ul style={{ fontSize: 13, margin: '12px 0 0', paddingLeft: 18, color: 'var(--warning)' }} aria-label="Warnings">
                      {spec.warnings.map((w) => <li key={w}>{w}</li>)}
                    </ul>
                  )}
                </div>

                <div className="card" style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                    <div className="metric-label">Diagram - click a component for its parameters and cost</div>
                    <label className={`checkbox-chip${showAll ? ' checked' : ''}`} style={{ marginLeft: 'auto' }}>
                      <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                      Show network and monitoring links
                    </label>
                  </div>
                  <div>
                    <div>
                      <ArchitectureDiagram spec={spec} selected={selected} onSelect={setSelected} showAll={showAll} />
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                        {[...new Set(spec.connections.map((c) => c.kind))].filter((k) => showAll || !KIND_STYLE[k].minor).map((k) => (
                          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={KIND_STYLE[k].color} strokeWidth="2" strokeDasharray={KIND_STYLE[k].dash} /></svg>
                            {KIND_STYLE[k].label}
                          </span>
                        ))}
                        <span>Dashed box: existing resource, reused</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10 }} aria-label="Component details">
                      {!sel ? (
                        <p style={{ color: 'var(--muted)' }}>Select a component in the diagram.</p>
                      ) : (
                        <>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{sel.label}</div>
                          <div style={{ color: 'var(--muted)', marginBottom: 6 }}><code>{sel.module}</code></div>
                          <p style={{ margin: '0 0 6px' }}>{sel.reason}</p>
                          {sel.resourceId && <p style={{ margin: '0 0 6px', wordBreak: 'break-all' }}><strong>Existing:</strong> {sel.resourceId}</p>}
                          {Object.keys(sel.params).length > 0 && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--bg)', padding: 8, borderRadius: 6, margin: '0 0 6px' }}>{JSON.stringify(sel.params, null, 2)}</pre>}
                          {spec.cost.lineItems.filter((l) => l.component === sel.id).map((l) => (
                            <div key={l.item} style={{ marginBottom: 4 }}><strong>{usd(l.monthlyUsd)}/month</strong>{l.oneTimeUsd ? ` + ${usd(l.oneTimeUsd)} once` : ''} - {l.item} ({l.quantity})</div>
                          ))}
                          <div style={{ color: 'var(--muted)', marginTop: 6 }}>
                            Connects to: {spec.connections.filter((c) => c.from === sel.id || c.to === sel.id).map((c) => `${c.from === sel.id ? c.to : c.from} (${KIND_STYLE[c.kind].label})`).join(', ') || 'nothing'}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card" style={{ marginBottom: 16 }} aria-label="Cost estimate">
                  <div className="metric-label" style={{ marginBottom: 8 }}>Cost estimate (directional, {spec.cost.currency}) - rate card {spec.cost.rateCard.version}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}><th style={cell}>Component</th><th style={cell}>Item</th><th style={cell}>Quantity</th><th style={{ ...cell, textAlign: 'right' }}>Monthly</th><th style={cell}>Basis</th></tr>
                    </thead>
                    <tbody>
                      {spec.cost.lineItems.map((l) => (
                        <tr key={l.component + l.item} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={cell}>{spec.components.find((c) => c.id === l.component)?.label ?? l.component}</td>
                          <td style={cell}>{l.item}</td>
                          <td style={cell}>{l.quantity}</td>
                          <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>{usd(l.monthlyUsd)}{l.oneTimeUsd ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>+{usd(l.oneTimeUsd)} once</div> : null}</td>
                          <td style={{ ...cell, color: 'var(--muted)', fontSize: 12 }}>{l.basis}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700 }}><td style={cell} colSpan={3}>Total</td><td style={{ ...cell, textAlign: 'right' }}>{usd(spec.cost.monthlyUsd)}</td><td style={cell} /></tr>
                    </tbody>
                  </table>
                  <p style={{ fontSize: 13, margin: '10px 0 4px' }}>
                    <strong>Model options:</strong> pay-as-you-go about {usd(spec.cost.modelOptions.paygMonthlyUsd)}/month; {spec.cost.modelOptions.ptuUnits} PTU about {usd(spec.cost.modelOptions.ptuMonthlyUsd)}/month.
                  </p>
                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>Assumptions</div>
                  <ul style={{ fontSize: 12, margin: '4px 0 0', paddingLeft: 18, color: 'var(--muted)' }}>
                    {spec.cost.assumptions.map((a) => <li key={a}>{a}</li>)}
                  </ul>
                </div>

                <div className="card" style={{ marginBottom: 16 }} aria-label="Architecture decisions">
                  <div className="metric-label" style={{ marginBottom: 8 }}>Architecture decision records (drafts - {spec.generator.explainer})</div>
                  {spec.adrs.map((a) => (
                    <details key={a.id} style={{ borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
                      <summary style={{ cursor: 'pointer', fontSize: 13 }}><strong>{a.id} · {a.title}</strong> - {a.choice} <span className="status-pill" style={{ marginLeft: 6 }}>{a.status}</span></summary>
                      <div style={{ fontSize: 13, padding: '6px 0 0 14px' }}>
                        <p style={{ margin: '0 0 4px' }}><strong>Context:</strong> {a.context}</p>
                        <p style={{ margin: '0 0 4px' }}><strong>Decision:</strong> {a.decision}</p>
                        <p style={{ margin: 0 }}><strong>Consequences:</strong> {a.consequences}</p>
                      </div>
                    </details>
                  ))}
                  <div style={{ fontSize: 12, marginTop: 10 }}>
                    <strong>Tags on every resource:</strong>{' '}
                    {Object.entries(spec.tags).map(([k, v]) => <span key={k} className={`status-pill ${v ? '' : 'warning'}`} style={{ marginRight: 4 }}>{k}: {v ?? 'not set'}</span>)}
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
                      v{h.version} · {h.spec.components.length} components · {usd(h.spec.cost.monthlyUsd)}/month · {h.spec.sizing.deploymentSku}
                      {h.spec.components.some((c) => c.id === 'apim') ? ' · gateway' : ''}{h.spec.components.some((c) => c.id === 'cosmos') ? ' · chat history' : ''} · use case v{h.useCaseVersion} · {new Date(h.createdAt).toLocaleString()}
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
