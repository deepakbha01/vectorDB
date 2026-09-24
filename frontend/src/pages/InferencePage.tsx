import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import {
  CreateInferenceAssessmentInput,
  DECISION_LABELS,
  InferenceAssessment,
  InferenceCatalogue,
  InferenceDefaultsSuggestion,
} from '../api/inference';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const DEFAULT_FORM: CreateInferenceAssessmentInput = {
  workloadType: 'rag',
  modelSourcing: 'evaluate_both',
  requestsPerDay: 50000,
  peakToAverageRatio: 3,
  avgInputTokens: 2000,
  avgOutputTokens: 300,
  maxContextTokens: 8192,
  monthlyGrowthPercent: 5,
  ttftTargetMs: 2000,
  tpotTargetMs: 50,
  availabilityTargetPercent: 99.9,
  modelId: 'llama-3.1-8b',
  precision: 'auto',
  allowedGpuIds: [],
  gpuPricing: 'on_demand',
  autoscaling: true,
  opsCapability: 'dedicated_team',
  managedApiTierId: 'mid',
  allowThirdPartyApi: true,
  containsPii: false,
};

const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const usdFine = (n: number) => '$' + n.toFixed(n < 1 ? 4 : 2);
const fmt = (n: number, d = 1) => Number(n.toFixed(d)).toLocaleString('en-US');
const cell = { padding: '6px 8px', verticalAlign: 'top' as const };

export function InferencePage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [catalogue, setCatalogue] = useState<InferenceCatalogue | null>(null);
  const [defaults, setDefaults] = useState<InferenceDefaultsSuggestion | null>(null);
  const [assessment, setAssessment] = useState<InferenceAssessment | null>(null);
  const [form, setForm] = useState<CreateInferenceAssessmentInput>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showWorkings, setShowWorkings] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient.get<InferenceCatalogue>(`/projects/${id}/inference/catalogue`).then((res) => setCatalogue(res.data));
    apiClient.get<InferenceDefaultsSuggestion>(`/projects/${id}/inference/defaults`).then((res) => setDefaults(res.data)).catch(() => setDefaults(null));
    apiClient
      .get<InferenceAssessment>(`/projects/${id}/inference/assessments/latest`)
      .then((res) => {
        setAssessment(res.data);
        setForm({ ...DEFAULT_FORM, ...res.data.submitted });
      })
      .catch(() => setAssessment(null));
  }, [id]);

  const set = <K extends keyof CreateInferenceAssessmentInput>(key: K, value: CreateInferenceAssessmentInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const applyDefaults = () => {
    if (!defaults) return;
    const { source, ragContextTokens, ...values } = defaults;
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null)) as Partial<CreateInferenceAssessmentInput>;
    setForm((f) => ({ ...f, ...clean }));
    setNotice(`Pre-filled from ${source.join(' + ')}${ragContextTokens ? ` - retrieved context ≈ ${ragContextTokens.toLocaleString()} tokens per request` : ''}. Review before submitting.`);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSubmitting(true);
    try {
      const payload: CreateInferenceAssessmentInput = { ...form };
      if (payload.modelId !== 'custom') {
        for (const k of ['customModelName', 'customParamsB', 'customActiveParamsB', 'customLayers', 'customKvHeads', 'customHeadDim', 'customMaxContextTokens'] as const) delete payload[k];
      }
      const { data } = await apiClient.post<InferenceAssessment>(`/projects/${id}/inference/assessments`, payload);
      setAssessment(data);
      setShowWorkings(false);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not run the inference assessment.'));
    } finally {
      setSubmitting(false);
    }
  };

  const onDownload = async (format: 'pdf' | 'docx') => {
    if (!id) return;
    setDownloading(format);
    try {
      const response = await apiClient.get(`/projects/${id}/inference/report`, { params: { format }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `inference-assessment-v${assessment?.version ?? ''}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not generate the report.'));
    } finally {
      setDownloading(null);
    }
  };

  if (!project || !catalogue) {
    return <div className="main-content">Loading...</div>;
  }

  const selectedModel = catalogue.models.find((m) => m.id === form.modelId);
  const tier = catalogue.managedApiTiers.find((t) => t.id === form.managedApiTierId);
  const r = assessment?.result;
  const rec = r?.recommendedGpuOption;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Inference-as-a-Service Assessment" />
        <p style={{ fontSize: 13, color: '#5a6472', maxWidth: 900, marginTop: -8 }}>
          Sizes model serving for this workload: GPU memory and throughput, latency against your targets, cost per token, and
          when self-hosting an open-weight model beats a managed API. Separate from the vector-database phases - it only reads
          them to suggest defaults.
        </p>

        {defaults && defaults.source.length > 0 && (
          <div className="card" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, maxWidth: 1100 }}>
            <span style={{ fontSize: 13 }}>
              This project has a vector assessment ({defaults.source.join(', ')}). Use its query rate, RAG context size, availability and
              compliance answers as a starting point?
            </span>
            <button type="button" className="primary-btn" onClick={applyDefaults}>
              Pre-fill
            </button>
          </div>
        )}
        {notice && <div className="card" style={{ marginBottom: 16, fontSize: 13, maxWidth: 1100, borderColor: '#b7dfc4', background: '#f1faf4' }}>{notice}</div>}

        <form className="discovery-form" style={{ maxWidth: 1100 }} onSubmit={onSubmit}>
          <Section index={1} title="Workload & demand" sub="What the model is used for and how much traffic it serves.">
            <Select label="Workload type" value={form.workloadType} onChange={(v) => set('workloadType', v as any)}
              options={[['rag', 'RAG answering'], ['chat', 'Chat assistant'], ['agent', 'Agent / tool use'], ['summarization', 'Summarisation'], ['code', 'Code generation'], ['classification', 'Classification / extraction'], ['batch', 'Offline batch']]} />
            <Select label="Serving options in scope" value={form.modelSourcing} onChange={(v) => set('modelSourcing', v as any)}
              options={[['evaluate_both', 'Compare self-hosted and managed API'], ['self_hosted', 'Self-hosted only'], ['managed_api', 'Managed API only']]} />
            <Num label="Requests per day" value={form.requestsPerDay} onChange={(v) => set('requestsPerDay', v ?? 0)} />
            <Num label="Peak-to-average ratio" value={form.peakToAverageRatio} step={0.1} onChange={(v) => set('peakToAverageRatio', v ?? 1)} hint="Peak-hour rate ÷ daily average" />
            <Num label="Avg input tokens / request" value={form.avgInputTokens} onChange={(v) => set('avgInputTokens', v ?? 0)} hint="System prompt + question + retrieved context" />
            <Num label="Avg output tokens / request" value={form.avgOutputTokens} onChange={(v) => set('avgOutputTokens', v ?? 0)} />
            <Num label="Max context (tokens)" value={form.maxContextTokens} onChange={(v) => set('maxContextTokens', v ?? 0)} hint="Longest request that must be served" />
            <Num label="Monthly growth (%)" value={form.monthlyGrowthPercent} step={0.1} onChange={(v) => set('monthlyGrowthPercent', v)} />
          </Section>

          <Section index={2} title="Latency & availability" sub="The service-level targets each option is tested against.">
            <Num label="Time to first token (ms)" value={form.ttftTargetMs} onChange={(v) => set('ttftTargetMs', v ?? 0)} hint="How long before the answer starts appearing" />
            <Num label="Time per output token (ms)" value={form.tpotTargetMs} onChange={(v) => set('tpotTargetMs', v ?? 0)}
              hint={form.tpotTargetMs > 0 ? `≈ ${fmt(1000 / form.tpotTargetMs, 0)} tokens/s per user` : undefined} />
            <Num label="Availability target (%)" value={form.availabilityTargetPercent} step={0.01} onChange={(v) => set('availabilityTargetPercent', v ?? 99)} />
          </Section>

          <Section index={3} title="Self-hosted model & GPUs" sub="The open-weight model to size, and the GPUs you can run it on.">
            <Select label="Model" value={form.modelId} onChange={(v) => set('modelId', v)}
              options={[...catalogue.models.map((m) => [m.id, `${m.label} · ${m.paramsB}B`] as [string, string]), ['custom', 'Custom model…']]} />
            <Select label="Precision" value={form.precision ?? 'auto'} onChange={(v) => set('precision', v)}
              options={[['auto', `Auto (${catalogue.autoPrecisions.map((p) => p.toUpperCase()).join(' / ')})`], ...catalogue.precisions.map((p) => [p.id, p.label] as [string, string])]} />
            <Select label="GPU pricing" value={form.gpuPricing ?? 'on_demand'} onChange={(v) => set('gpuPricing', v as any)}
              options={[['on_demand', 'On-demand'], ['reserved_1yr', '1-year reserved'], ['spot', 'Spot / preemptible']]} />
            <Select label="MLOps capability" value={form.opsCapability} onChange={(v) => set('opsCapability', v as any)}
              options={[['none', 'None'], ['part_time', 'Part-time'], ['dedicated_team', 'Dedicated team'], ['platform_team', 'Platform team (24x7)']]} />
            {selectedModel && (
              <p style={{ gridColumn: '1 / -1', fontSize: 12, color: '#5a6472', margin: 0 }}>
                {selectedModel.layers} layers · {selectedModel.kvHeads} KV heads · {selectedModel.maxContextTokens.toLocaleString()}-token context
                {selectedModel.activeParamsB !== selectedModel.paramsB ? ` · ${selectedModel.activeParamsB}B active (MoE)` : ''} · {selectedModel.licence}
              </p>
            )}
            {form.modelId === 'custom' && (
              <>
                <Text label="Model name" value={form.customModelName ?? ''} onChange={(v) => set('customModelName', v)} />
                <Num label="Total params (B)" value={form.customParamsB} step={0.1} onChange={(v) => set('customParamsB', v)} />
                <Num label="Active params (B)" value={form.customActiveParamsB} step={0.1} onChange={(v) => set('customActiveParamsB', v)} hint="MoE only - blank = total" />
                <Num label="Layers" value={form.customLayers} onChange={(v) => set('customLayers', v)} />
                <Num label="KV heads" value={form.customKvHeads} onChange={(v) => set('customKvHeads', v)} />
                <Num label="Head dimension" value={form.customHeadDim} onChange={(v) => set('customHeadDim', v)} />
                <Num label="Model max context" value={form.customMaxContextTokens} onChange={(v) => set('customMaxContextTokens', v)} />
              </>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>GPUs available (none ticked = all)</label>
              <div className="checkbox-grid">
                {catalogue.gpus.map((g) => {
                  const checked = form.allowedGpuIds?.includes(g.id) ?? false;
                  return (
                    <label key={g.id} className={`checkbox-chip${checked ? ' checked' : ''}`} title={`${g.bandwidthGbps} GB/s · ${g.interconnect ?? ''} · $${g.hourlyUsd}/h on-demand`}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => set('allowedGpuIds', e.target.checked ? [...(form.allowedGpuIds ?? []), g.id] : (form.allowedGpuIds ?? []).filter((x) => x !== g.id))} />
                      {g.label}
                    </label>
                  );
                })}
              </div>
            </div>
            <Check label="Autoscale replicas with load" checked={form.autoscaling ?? true} onChange={(v) => set('autoscaling', v)} />
          </Section>

          <Section index={4} title="Managed API comparison" sub="The pay-per-token alternative. Enter contracted prices if you have them.">
            <Select label="API price tier" value={form.managedApiTierId} onChange={(v) => set('managedApiTierId', v)}
              options={catalogue.managedApiTiers.map((t) => [t.id, `${t.label} ($${t.inputPer1M} / $${t.outputPer1M})`] as [string, string])} />
            <Num label="Input $ / 1M tokens (override)" value={form.apiInputPricePer1M} step={0.01} onChange={(v) => set('apiInputPricePer1M', v)} hint={tier ? `List: $${tier.inputPer1M}` : undefined} />
            <Num label="Output $ / 1M tokens (override)" value={form.apiOutputPricePer1M} step={0.01} onChange={(v) => set('apiOutputPricePer1M', v)} hint={tier ? `List: $${tier.outputPer1M}` : undefined} />
          </Section>

          <Section index={5} title="Data, compliance & budget" sub="Constraints that can rule an option out.">
            <Check label="Prompts may be sent to a third-party model API" checked={form.allowThirdPartyApi} onChange={(v) => set('allowThirdPartyApi', v)} />
            <Check label="Prompts or responses contain PII" checked={form.containsPii} onChange={(v) => set('containsPii', v)} />
            <Text label="Data residency requirement" value={form.dataResidencyRequirement ?? ''} onChange={(v) => set('dataResidencyRequirement', v || undefined)} />
            <Num label="Monthly budget (USD)" value={form.monthlyBudgetUsd} onChange={(v) => set('monthlyBudgetUsd', v)} />
          </Section>

          {error && <div className="error-text">{error}</div>}
          <div>
            <button className="primary-btn" type="submit" disabled={submitting}>
              {submitting ? 'Assessing...' : assessment ? 'Re-run assessment (new version)' : 'Run inference assessment'}
            </button>
          </div>
        </form>

        {assessment && r && (
          <div style={{ marginTop: 28, maxWidth: 1100 }}>
            <div className="card" style={{ marginBottom: 16, borderLeft: `4px solid ${r.decision === 'none_feasible' ? '#c0392b' : '#2f6fde'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div className="metric-label">Recommendation · version {assessment.version} · {new Date(assessment.createdAt).toLocaleString()}</div>
                  <div className="metric-value" style={{ fontSize: 22 }}>{DECISION_LABELS[r.decision]}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <button className="primary-btn" type="button" onClick={() => onDownload('pdf')} disabled={downloading !== null}>{downloading === 'pdf' ? 'Generating...' : 'PDF'}</button>
                  <button className="primary-btn" type="button" onClick={() => onDownload('docx')} disabled={downloading !== null}>{downloading === 'docx' ? 'Generating...' : 'DOCX'}</button>
                </div>
              </div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>{r.decisionRationale.map((x) => <li key={x}>{x}</li>)}</ul>
              <button type="button" onClick={() => setShowWorkings((s) => !s)}
                style={{ marginTop: 10, background: 'none', border: 'none', padding: 0, color: '#2f6fde', textDecoration: 'underline', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {showWorkings ? 'Hide calculation' : 'Show calculation →'}
              </button>
              {showWorkings && (
                <Table headers={['Step', 'Formula (with your values)', 'Result']}
                  rows={r.workings.map((w) => [w.step, <code key="f" style={{ fontSize: 12 }}>{w.formula}</code>, <strong key="r">{w.result}</strong>])} />
              )}
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <Metric label="Peak load" value={`${fmt(r.demand.peakRps, 2)} req/s`} sub={`${fmt(r.demand.peakOutputTokensPerSec, 0)} output tokens/s`} />
              <Metric label="Self-hosted / month" value={usd(rec?.monthlyTotalUsd)} sub={rec ? `${rec.totalGpusAtPeak} × ${rec.gpuLabel} · ${usdFine(rec.costPerMillionTokensUsd)}/1M tokens` : 'No option meets the latency targets'} />
              <Metric label="Managed API / month" value={r.managedApi.excluded ? 'Excluded' : usd(r.managedApi.monthlyUsd)}
                sub={r.managedApi.excluded ? r.managedApi.exclusionReason : `${r.managedApi.tierLabel} · ${usdFine(r.managedApi.costPerMillionTokensUsd)}/1M tokens`} />
              <Metric label="Break-even" value={r.breakEven.breakEvenRequestsPerDay === null ? '—' : `${r.breakEven.breakEvenRequestsPerDay.toLocaleString()}/day`} sub={r.breakEven.note} />
            </div>

            <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
              <div className="metric-label" style={{ marginBottom: 8 }}>Self-hosted GPU options (best tensor-parallel degree per GPU and precision)</div>
              <Table
                headers={['GPU', 'Precision', 'GPUs / replica', 'Batch', 'TTFT', 'Per token', 'Replicas (peak / avg)', 'GPUs at peak', 'Monthly', '$ / 1M tokens', 'Targets']}
                rows={r.gpuOptions.map((o) => {
                  const ok = o.meetsTtft && o.meetsTpot;
                  const isRec = rec && o.gpuId === rec.gpuId && o.precision === rec.precision;
                  return [
                    <span key="g" title={o.notes.join('\n')}>{isRec ? '★ ' : ''}{o.gpuLabel}{o.notes.length ? ' ⓘ' : ''}</span>,
                    o.precision.toUpperCase(),
                    o.tensorParallel,
                    o.batchSize,
                    <span key="t" style={{ color: o.meetsTtft ? undefined : '#c0392b' }}>{fmt(o.ttftMs, 0)} ms</span>,
                    <span key="p" style={{ color: o.meetsTpot ? undefined : '#c0392b' }}>{fmt(o.tpotMs)} ms</span>,
                    `${o.replicasAtPeak} / ${o.replicasAtAverage}`,
                    o.totalGpusAtPeak.toLocaleString(),
                    usd(o.monthlyTotalUsd),
                    usdFine(o.costPerMillionTokensUsd),
                    <span key="ok" style={{ color: ok ? '#1e8449' : '#c0392b', fontWeight: 600 }}>{ok ? '✓ Met' : '✗ Missed'}</span>,
                  ];
                })}
              />
              <p style={{ fontSize: 12, color: '#5a6472', margin: '8px 0 0' }}>★ recommended · hover ⓘ for notes (quality, interconnect, memory limits). Monthly = GPUs + infrastructure overhead + platform team.</p>
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card" style={{ overflowX: 'auto' }}>
                <div className="metric-label" style={{ marginBottom: 8 }}>Growth forecast</div>
                <Table headers={['Horizon', 'Requests/day', 'Self-hosted', 'GPUs', 'Managed API']}
                  rows={r.forecast.map((f) => [`${f.horizonMonths} mo`, f.requestsPerDay.toLocaleString(), usd(f.selfHostedMonthlyUsd), f.selfHostedTotalGpus ?? '—', usd(f.managedApiMonthlyUsd)])} />
              </div>
              <div className="card" style={{ overflowX: 'auto' }}>
                <div className="metric-label" style={{ marginBottom: 8 }}>Cost by volume (monthly)</div>
                <Table headers={['Requests/day', 'Self-hosted', 'Managed API', 'Cheaper']}
                  rows={r.breakEven.curve.filter((_, i) => i % 10 === 0).map((p) => [
                    p.requestsPerDay.toLocaleString(),
                    usd(p.selfHostedMonthlyUsd),
                    usd(p.managedApiMonthlyUsd),
                    p.selfHostedMonthlyUsd === null ? 'API' : p.selfHostedMonthlyUsd <= p.managedApiMonthlyUsd ? 'Self-hosted' : 'API',
                  ])} />
              </div>
            </div>

            <div className="card-grid" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="metric-label">Risks</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>{(r.risks.length ? r.risks : ['None flagged.']).map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
              <div className="card">
                <div className="metric-label">Assumptions</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#5a6472' }}>{r.assumptions.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function Section({ index, title, sub, children }: { index: number; title: string; sub: string; children: ReactNode }) {
  return (
    <section className="discovery-section">
      <div className="discovery-section-header">
        <span className="discovery-section-index">{index}</span>
        <h2 className="discovery-section-title">{title}</h2>
      </div>
      <p className="discovery-section-sub">{sub}</p>
      <div className="field-grid">{children}</div>
    </section>
  );
}

function Num({ label, value, onChange, step, hint }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; step?: number; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" step={step ?? 1} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      {hint && <div style={{ fontSize: 11, color: '#5a6472', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`checkbox-chip${checked ? ' checked' : ''}`} style={{ alignSelf: 'end' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#5a6472', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>{headers.map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: '1px solid #eceff3' }}>{row.map((c, j) => <td key={j} style={cell}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
