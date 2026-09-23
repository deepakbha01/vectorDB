import { ArchitectureDecisionRecord } from '../vector-db-selection/architecture-decision-record.entity';
import { AssumptionType, EligibilityStatus } from '../recommendation-engine/recommendation.types';
import { IndexDesign } from '../index-design/index-design.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { InferenceAssessment } from '../inference/inference-assessment.entity';
import { DecisionAlternative, DecisionCandidate, DecisionRecord, Eligibility, EvidenceType } from './ai-factory.types';

/**
 * Adapters from each phase's EXISTING deliverable to the standard decision
 * record (spec §3, §16, §17, §24). Pure and read-only: they re-present what a
 * phase already decided; they never re-score or change it.
 */

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Spec §17: never offer an alternative that failed a mandatory requirement; show at most two. */
export function pickAlternatives(candidates: DecisionAlternative[], recommendationId: string | null): DecisionAlternative[] {
  return candidates.filter((a) => a.id !== recommendationId && a.eligibility !== 'not_eligible').slice(0, 2);
}

const ELIGIBILITY_FROM_ADR: Record<EligibilityStatus, Eligibility> = { eligible: 'eligible', unverified: 'conditional', ineligible: 'not_eligible' };

/** Spec §13 evidence labels. Customer answers are unverified inputs, so they count as assumptions until validated. */
const EVIDENCE_FROM_ASSUMPTION: Record<AssumptionType, EvidenceType> = {
  customer_provided: 'assumption',
  architect_provided: 'assumption',
  pattern_default: 'assumption',
  unknown: 'assumption',
  calculated: 'estimated',
  directional: 'estimated',
};

// ------------------------------------------------------ Vector DB selection
export function fromVectorDbSelection(adr: ArchitectureDecisionRecord, version: number): DecisionRecord {
  const label = (id: string) => adr.options.find((o) => o.platformId === id)?.label ?? id;
  const eligibilityOf = (id: string): Eligibility => {
    const o = adr.options.find((x) => x.platformId === id);
    return o ? ELIGIBILITY_FROM_ADR[o.eligibilityStatus] : 'not_assessed';
  };
  const candidates: DecisionCandidate[] = [...adr.options]
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((o) => ({ id: o.platformId, label: o.label, eligibility: ELIGIBILITY_FROM_ADR[o.eligibilityStatus], score: o.totalScore, notes: [...o.eligibilityNotes, ...o.evidence] }));

  const alternatives = pickAlternatives(
    adr.rejectedAlternatives.map((a) => ({ id: a.platformId, label: label(a.platformId), eligibility: eligibilityOf(a.platformId), reason: a.reason })),
    adr.decision,
  );
  const recommendedEligibility = eligibilityOf(adr.decision);

  const wouldChangeIf = [
    ...adr.rejectedAlternatives.filter((a) => a.bucket === 'tied' || a.bucket === 'strong').map((a) => `${label(a.platformId)} would be chosen if: ${a.reason}`),
    ...(adr.budgetFeasibility?.status === 'exceeds_budget' ? [`The monthly budget of ${usd(adr.budgetFeasibility.monthlyBudgetUsd)} is fixed - the estimate exceeds it.`] : []),
    ...(adr.complianceGate?.status === 'unverified' ? ['Required compliance controls cannot be verified on the chosen platform.'] : []),
    'Vector count, QPS, latency/recall targets or existing-platform answers change materially (see Impact analysis).',
  ];

  return {
    phase: 'vector_db_selection',
    title: 'Vector database',
    source: { deliverableId: adr.id, version, createdAt: adr.createdAt },
    status: adr.decisionStatus === 'tied' ? 'tied' : adr.decisionStatus === 'conditional' ? 'conditional' : 'decided',
    recommendation: { id: adr.decision, label: label(adr.decision) },
    confidence: adr.confidence,
    why: uniq([adr.rationale, adr.plainLanguageSummary?.headline ?? '']),
    candidates,
    alternatives,
    tradeoffs: uniq([`Operational complexity: ${adr.operationalComplexity}.`, ...alternatives.map((a) => `${a.label}: ${a.reason}`)]),
    risks: adr.risks.map((r) => `${r.description} (impact ${r.impact}, likelihood ${r.likelihood}). Mitigation: ${r.mitigation}`),
    assumptions: adr.assumptions.map((a) => ({ statement: `${a.parameter} = ${a.value} (${a.source})`, evidenceType: EVIDENCE_FROM_ASSUMPTION[a.type] ?? 'assumption' })),
    evidence: [
      { label: 'Estimated memory', value: `${adr.infrastructureEstimate.estimatedMemoryGb} GB`, evidenceType: 'estimated' },
      { label: 'Estimated storage', value: `${adr.infrastructureEstimate.estimatedStorageGb} GB`, evidenceType: 'estimated' },
      { label: 'Estimated CPU', value: `${adr.infrastructureEstimate.estimatedCpuCores} cores`, evidenceType: 'estimated' },
      ...(adr.budgetFeasibility
        ? [{ label: 'Budget check', value: `${adr.budgetFeasibility.status.replace(/_/g, ' ')}${adr.budgetFeasibility.estimatedMonthlyCostUsd !== null ? ` (est. ${usd(adr.budgetFeasibility.estimatedMonthlyCostUsd)}/month)` : ''}`, evidenceType: 'estimated' as const }]
        : []),
      ...(adr.complianceGate?.applicable ? [{ label: 'Compliance gate', value: adr.complianceGate.status, evidenceType: 'assumption' as const }] : []),
    ],
    benchmarkRequired: uniq([
      ...adr.openValidations,
      ...adr.risks.filter((r) => r.validationRequired).map((r) => `Validate: ${r.description}`),
      ...adr.assumptions.filter((a) => a.validationRequired).map((a) => `Confirm ${a.parameter} (${a.value})`),
    ]),
    wouldChangeIf,
    gaps: recommendedEligibility === 'not_eligible' ? ['The recommended platform is marked not eligible - re-run Vector DB Selection.'] : [],
  };
}

// ------------------------------------------------------------- Index design
export function fromIndexDesign(design: IndexDesign, optimization: OptimizationReport | null): DecisionRecord {
  const label = (id: string) => design.options.find((o) => o.indexType === id)?.label ?? id;
  const measured = optimization && optimization.indexType === design.decision ? optimization : null;

  return {
    phase: 'index_design',
    title: 'Vector index',
    source: { deliverableId: design.id, version: design.version, createdAt: design.createdAt },
    status: 'decided',
    recommendation: { id: design.decision, label: design.label },
    confidence: 'not_assessed',
    why: [design.rationale],
    candidates: [...design.options]
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((o) => ({ id: o.indexType, label: o.label, eligibility: 'not_assessed' as const, score: o.totalScore, notes: o.evidence })),
    // Index options have no eligibility layer yet, so none can be excluded as "not eligible" here.
    alternatives: pickAlternatives(design.alternatives.map((a) => ({ id: a.indexType, label: label(a.indexType), eligibility: 'not_assessed' as const, reason: a.reason })), design.decision),
    tradeoffs: design.scalingConsiderations,
    risks: [],
    assumptions: [
      { statement: `Update frequency: ${design.updateFrequency}`, evidenceType: 'assumption' },
      ...Object.entries(design.inputsUsed ?? {}).map(([k, v]) => ({ statement: `${k} = ${v}`, evidenceType: 'assumption' as const })),
    ],
    evidence: [
      ...design.configuration.map((p) => ({ label: p.name, value: String(p.value), evidenceType: 'estimated' as const })),
      { label: 'Memory', value: `${design.impact.memoryEstimateGb} GB`, evidenceType: 'estimated' },
      ...(measured
        ? [
            { label: 'Recall@K (benchmark)', value: measured.recommendedVariant.avgRecall.toFixed(3), evidenceType: 'measured' as const },
            { label: 'P95 latency (benchmark)', value: `${measured.recommendedVariant.p95LatencyMs.toFixed(1)} ms`, evidenceType: 'measured' as const },
          ]
        : [
            { label: 'Recall', value: design.impact.recallEstimate, evidenceType: 'estimated' as const },
            { label: 'Latency', value: design.impact.latencyEstimate, evidenceType: 'estimated' as const },
          ]),
    ],
    benchmarkRequired: measured
      ? [`Benchmark v${measured.version} measured a ${measured.sampleSize.toLocaleString()}-vector sample - confirm at production scale before go-live.`]
      : ['Run the Optimization benchmark to measure recall@K and P95 latency with these parameters.'],
    wouldChangeIf: ['Vector count, dimension, available memory, update frequency, or the recall/latency targets change.'],
    gaps: ['Index options have no mandatory-eligibility layer or confidence yet (spec §3) - planned for Wave 3.'],
  };
}

// --------------------------------------------------------------- Inference
export function fromInferenceAssessment(a: InferenceAssessment): DecisionRecord {
  const r = a.result;
  const rec = r.recommendedGpuOption;
  const optId = (o: { gpuId: string; precision: string }) => `${o.gpuId}:${o.precision}`;
  const optLabel = (o: { gpuLabel: string; precision: string; totalGpusAtPeak: number }) => `${o.totalGpusAtPeak} × ${o.gpuLabel} (${o.precision.toUpperCase()})`;

  const gpuCandidates: DecisionCandidate[] = r.gpuOptions.map((o) => ({
    id: optId(o),
    label: optLabel(o),
    eligibility: o.meetsTtft && o.meetsTpot ? 'eligible' : 'not_eligible',
    score: null,
    notes: [`${usd(o.monthlyTotalUsd)}/month`, `TTFT ${Math.round(o.ttftMs)} ms, ${o.tpotMs.toFixed(1)} ms/token`, ...o.notes],
  }));
  const apiCandidate: DecisionCandidate = {
    id: 'managed_api',
    label: `Managed API - ${r.managedApi.tierLabel}`,
    eligibility: r.managedApi.excluded ? 'not_eligible' : 'eligible',
    score: null,
    notes: r.managedApi.excluded ? [r.managedApi.exclusionReason ?? 'Excluded'] : [`${usd(r.managedApi.monthlyUsd)}/month`],
  };

  const recommendation =
    r.decision === 'managed_api'
      ? { id: apiCandidate.id, label: apiCandidate.label }
      : rec && (r.decision === 'self_hosted' || r.decision === 'either')
        ? { id: optId(rec), label: optLabel(rec) }
        : null;

  const altPool: DecisionAlternative[] = [
    ...(r.decision !== 'managed_api' ? [{ id: apiCandidate.id, label: apiCandidate.label, eligibility: apiCandidate.eligibility, reason: apiCandidate.notes.join('; ') }] : []),
    ...gpuCandidates.map((c) => ({ id: c.id, label: c.label, eligibility: c.eligibility, reason: c.notes.slice(0, 2).join('; ') })),
  ];

  return {
    phase: 'inference',
    title: 'Inference serving',
    source: { deliverableId: a.id, version: a.version, createdAt: a.createdAt },
    status: r.decision === 'none_feasible' ? 'not_feasible' : r.decision === 'either' ? 'conditional' : 'decided',
    recommendation,
    // Every serving figure is a model estimate until load-tested, so confidence is capped at medium.
    confidence: r.decision === 'none_feasible' ? 'low' : r.decision === 'either' ? 'low' : 'medium',
    why: r.decisionRationale,
    candidates: [apiCandidate, ...gpuCandidates],
    alternatives: pickAlternatives(altPool, recommendation?.id ?? null),
    tradeoffs: [r.breakEven.note],
    risks: r.risks,
    assumptions: r.assumptions.map((s) => ({ statement: s, evidenceType: 'assumption' as const })),
    evidence: [
      ...(rec
        ? [
            { label: 'Self-hosted cost', value: `${usd(rec.monthlyTotalUsd)}/month`, evidenceType: 'estimated' as const },
            { label: 'GPU list price', value: `$${rec.gpuHourlyUsd.toFixed(2)}/GPU-hour`, evidenceType: 'vendor_listed' as const },
            { label: 'Time to first token', value: `${Math.round(rec.ttftMs)} ms`, evidenceType: 'estimated' as const },
            { label: 'Time per output token', value: `${rec.tpotMs.toFixed(1)} ms`, evidenceType: 'estimated' as const },
          ]
        : []),
      { label: 'Managed API cost', value: `${usd(r.managedApi.monthlyUsd)}/month`, evidenceType: 'estimated' },
      { label: 'Managed API price', value: `$${r.managedApi.inputPer1M} in / $${r.managedApi.outputPer1M} out per 1M tokens`, evidenceType: 'vendor_listed' },
    ],
    benchmarkRequired: [
      ...(rec ? [`Load-test TTFT and time per token at ${r.demand.peakRps.toFixed(2)} req/s peak on ${rec.gpuLabel} before committing capacity.`] : []),
      'Run the customer evaluation set on the self-hosted model and the API tier - quality equivalence is not assessed.',
    ],
    wouldChangeIf: [r.breakEven.note, 'Latency targets, request volume, tokens per request, or the third-party API policy change.'],
    gaps: ['Serving-technology evaluation (vLLM, Triton, managed endpoints) and gateway/router design arrive in Wave 4.'],
  };
}
