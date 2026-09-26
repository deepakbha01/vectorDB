import { ReportDocument } from '../reporting/report-document.types';
import { InferenceAssessment } from './inference-assessment.entity';
import { InferenceDecision } from './inference.types';

const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const usdFine = (n: number) => '$' + n.toFixed(n < 1 ? 4 : 2);
const num = (n: number, d = 1) => Number(n.toFixed(d)).toLocaleString('en-US');

export const DECISION_LABELS: Record<InferenceDecision, string> = {
  self_hosted: 'Self-host open-weight model on GPUs',
  managed_api: 'Use a managed model API',
  either: 'Either - cost is comparable; decide on control and operating model',
  none_feasible: 'No feasible option under the current constraints',
};

/**
 * Converts an Inference assessment into the shared, format-agnostic report
 * representation so the existing PDF/DOCX renderers can export it unchanged.
 */
export function buildInferenceReport(projectName: string, a: InferenceAssessment): ReportDocument {
  const r = a.result;
  const i = a.inputsUsed;
  const rec = r.recommendedGpuOption;
  return {
    title: 'Inference Assessment',
    subtitle: `${projectName} · version ${a.version} · rules ${a.rulesVersion}`,
    generatedAt: new Date().toISOString(),
    sections: [
      {
        heading: 'Recommendation',
        fields: [
          { label: 'Decision', value: DECISION_LABELS[r.decision] },
          { label: 'Self-hosted (recommended configuration)', value: rec ? `${usd(rec.monthlyTotalUsd)}/month · ${rec.totalGpusAtPeak} × ${rec.gpuLabel} (${rec.precision.toUpperCase()})` : 'No configuration meets the latency targets' },
          { label: 'Managed API', value: r.managedApi.excluded ? `Excluded - ${r.managedApi.exclusionReason}` : `${usd(r.managedApi.monthlyUsd)}/month (${r.managedApi.tierLabel})` },
          { label: 'Break-even', value: r.breakEven.note },
        ],
        lists: [{ title: 'Rationale', items: r.decisionRationale }],
      },
      {
        heading: 'Workload profile',
        fields: [
          { label: 'Workload type', value: i.workloadType },
          { label: 'Model', value: `${i.model.label} (${i.model.paramsB}B params${i.model.activeParamsB !== i.model.paramsB ? `, ${i.model.activeParamsB}B active` : ''})` },
          { label: 'Requests per day', value: num(i.requestsPerDay, 0) },
          { label: 'Peak-to-average ratio', value: String(i.peakToAverageRatio) },
          { label: 'Tokens per request', value: `${i.avgInputTokens} in / ${i.avgOutputTokens} out (max context ${i.maxContextTokens.toLocaleString()})` },
          { label: 'Latency targets', value: `TTFT <= ${i.ttftTargetMs} ms · TPOT <= ${i.tpotTargetMs} ms` },
          { label: 'Availability target', value: `${i.availabilityTargetPercent}%` },
          { label: 'Monthly growth', value: `${i.monthlyGrowthPercent}%` },
          { label: 'Third-party API allowed', value: i.allowThirdPartyApi ? 'Yes' : 'No' },
        ],
      },
      {
        heading: 'Demand',
        fields: [
          { label: 'Average load', value: `${num(r.demand.avgRps, 2)} req/s` },
          { label: 'Peak load', value: `${num(r.demand.peakRps, 2)} req/s` },
          { label: 'Peak output throughput', value: `${num(r.demand.peakOutputTokensPerSec, 0)} tokens/s` },
          { label: 'Monthly tokens', value: `${num(r.demand.tokensPerMonth / 1e6)} M` },
        ],
      },
      {
        heading: 'Self-hosted GPU options',
        tables: [
          {
            headers: ['GPU', 'Precision', 'TP', 'Batch', 'TTFT ms', 'TPOT ms', 'Replicas (peak)', 'GPUs', 'Monthly', '$/1M tokens', 'Meets SLO'],
            rows: r.gpuOptions.map((o) => [
              o.gpuLabel,
              o.precision.toUpperCase(),
              String(o.tensorParallel),
              String(o.batchSize),
              num(o.ttftMs, 0),
              num(o.tpotMs),
              String(o.replicasAtPeak),
              String(o.totalGpusAtPeak),
              usd(o.monthlyTotalUsd),
              usdFine(o.costPerMillionTokensUsd),
              o.meetsTtft && o.meetsTpot ? 'Yes' : 'No',
            ]),
          },
        ],
      },
      {
        heading: 'Growth forecast',
        tables: [
          {
            headers: ['Horizon', 'Requests/day', 'Self-hosted / month', 'GPUs', 'Managed API / month'],
            rows: r.forecast.map((f) => [`${f.horizonMonths}mo`, f.requestsPerDay.toLocaleString(), usd(f.selfHostedMonthlyUsd), f.selfHostedTotalGpus === null ? '—' : String(f.selfHostedTotalGpus), usd(f.managedApiMonthlyUsd)]),
          },
        ],
      },
      {
        heading: 'How this was calculated',
        tables: [{ headers: ['Step', 'Formula', 'Result'], rows: r.workings.map((w) => [w.step, w.formula, w.result]) }],
      },
      { heading: 'Risks', lists: [{ items: r.risks.length ? r.risks : ['None flagged.'] }] },
      { heading: 'Assumptions', lists: [{ items: r.assumptions }] },
    ],
  };
}
