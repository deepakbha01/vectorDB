import { ArchitectureDecisionRecord } from '../vector-db-selection/architecture-decision-record.entity';
import { AssumptionType, EligibilityStatus } from '../recommendation-engine/recommendation.types';
import { IndexDesign } from '../index-design/index-design.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { InferenceAssessment } from '../inference/inference-assessment.entity';
import { DataPipelineDesign } from '../data-pipeline/data-pipeline-design.entity';
import { AiModelSelection } from './model-selection/model-selection.entity';
import { EmbeddingEligibilityRules, EmbeddingModelFacts, IndexEligibilityRules, embeddingEligibility, indexEligibility, scoreEmbedding } from './eligibility/eligibility.rules';
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
/**
 * With `rules`, applies the Wave 3 eligibility layer to every option. The
 * Index Design engine's choice is shown as-is; if it fails a mandatory rule
 * the record says so (status conditional, low confidence, a gap to resolve)
 * rather than silently substituting another index.
 */
export function fromIndexDesign(design: IndexDesign, optimization: OptimizationReport | null, rules?: IndexEligibilityRules, confidenceMargin = 0.05): DecisionRecord {
  const label = (id: string) => design.options.find((o) => o.indexType === id)?.label ?? id;
  const measured = optimization && optimization.indexType === design.decision ? optimization : null;
  const ctx = { availableMemoryGb: design.inputsUsed?.availableMemoryGb ?? 0, recallTarget: design.inputsUsed?.recallTarget ?? 0, updateFrequency: design.updateFrequency };
  const verdicts = new Map(design.options.map((o) => [o.indexType as string, rules ? indexEligibility({ indexType: o.indexType, estimatedMemoryGb: o.estimatedMemoryGb }, ctx, rules) : null]));
  const eligibilityOf = (id: string): Eligibility => verdicts.get(id)?.eligibility ?? 'not_assessed';

  const candidates = [...design.options]
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((o) => {
      const v = verdicts.get(o.indexType);
      return { id: o.indexType, label: o.label, eligibility: eligibilityOf(o.indexType), score: o.totalScore, notes: [...(v?.failures ?? []), ...(v?.conditions ?? []), ...o.evidence] };
    });
  const chosen = verdicts.get(design.decision) ?? null;
  const usable = candidates.filter((c) => c.eligibility === 'eligible' || c.eligibility === 'conditional');
  const bestUsable = usable[0];
  const chosenScore = candidates.find((c) => c.id === design.decision)?.score ?? 0;
  const nextUsable = usable.find((c) => c.id !== design.decision);

  let status: DecisionRecord['status'] = 'decided';
  let confidence: DecisionRecord['confidence'] = 'not_assessed';
  const gaps: string[] = [];
  const wouldChangeIf = ['Vector count, dimension, available memory, update frequency, or the recall/latency targets change.'];
  if (chosen) {
    if (chosen.eligibility === 'not_eligible') {
      status = 'conditional';
      confidence = 'low';
      gaps.push(`Index Design chose ${design.label}, which fails a mandatory rule: ${chosen.failures.join(' ')} Re-run Index Design (or change memory / recall inputs) before relying on it${bestUsable ? `; ${bestUsable.label} is the best option that passes` : ''}.`);
    } else if (chosen.eligibility === 'conditional') {
      status = 'conditional';
      confidence = 'medium';
    } else {
      confidence = nextUsable && chosenScore - nextUsable.score < confidenceMargin ? 'medium' : 'high';
    }
    if (bestUsable && bestUsable.id !== design.decision && chosen.eligibility !== 'not_eligible') {
      wouldChangeIf.unshift(`${bestUsable.label} passes every rule with fewer conditions - prefer it if ${chosen.conditions[0]?.toLowerCase() ?? 'the chosen index\'s conditions cannot be met'}.`);
    }
  } else {
    gaps.push('Index options have no mandatory-eligibility layer or confidence yet (spec §3) - planned for Wave 3.');
  }

  return {
    phase: 'index_design',
    title: 'Vector index',
    source: { deliverableId: design.id, version: design.version, createdAt: design.createdAt },
    status,
    recommendation: { id: design.decision, label: design.label },
    confidence,
    why: [design.rationale],
    candidates,
    alternatives: pickAlternatives(design.alternatives.map((a) => ({ id: a.indexType, label: label(a.indexType), eligibility: eligibilityOf(a.indexType), reason: a.reason })), design.decision),
    tradeoffs: design.scalingConsiderations,
    risks: chosen ? [...chosen.failures, ...chosen.conditions] : [],
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
    benchmarkRequired: [
      ...(measured
        ? [`Benchmark v${measured.version} measured a ${measured.sampleSize.toLocaleString()}-vector sample - confirm at production scale before go-live.`]
        : ['Run the Optimization benchmark to measure recall@K and P95 latency with these parameters.']),
      ...(chosen?.conditions ?? []).map((c) => `Validate: ${c}`),
    ],
    wouldChangeIf,
    gaps,
  };
}

// ---------------------------------------------------------- Embedding model
export interface EmbeddingDecisionContext {
  chunkTokens: number;
  selfHostingRequired: boolean;
  multilingual: boolean;
  /** Where the two booleans above came from, for the assumptions list. */
  basis: string[];
}

/**
 * Embedding choice (spec §5) with the Wave 3 eligibility layer. The Data
 * Pipeline Design's chosen model stays the recommendation; every catalogue
 * model is checked against mandatory rules and scored, and a chosen model
 * that fails a rule is flagged for review.
 */
export function fromDataPipelineDesign(
  pipeline: DataPipelineDesign,
  catalogue: EmbeddingModelFacts[],
  ctx: EmbeddingDecisionContext,
  rules: EmbeddingEligibilityRules,
  confidenceMargin = 0.05,
): DecisionRecord {
  const key = (m: { providerId: string; modelId: string }) => `${m.providerId}/${m.modelId}`;
  const chosenKey = `${pipeline.embeddingProviderId}/${pipeline.embeddingModelId}`;
  const evaluated = catalogue
    .map((m) => ({ m, v: embeddingEligibility(m, ctx, rules), score: scoreEmbedding(m, catalogue, rules) }))
    .sort((a, b) => b.score - a.score);
  const chosen = evaluated.find((e) => key(e.m) === chosenKey) ?? null;
  const usable = evaluated.filter((e) => e.v.eligibility !== 'not_eligible');
  const bestUsable = usable[0];
  const nextUsable = usable.find((e) => key(e.m) !== chosenKey);

  const candidates: DecisionCandidate[] = evaluated.map((e) => ({
    id: key(e.m),
    label: e.m.label,
    eligibility: e.v.eligibility,
    score: e.score,
    notes: [...e.v.failures, ...e.v.conditions, `${e.m.dimension} dims, ${e.m.maxInputTokens.toLocaleString()} max tokens, $${e.m.costPerMillionTokens}/1M tokens, quality ${e.m.qualityTier}`],
  }));

  let status: DecisionRecord['status'] = 'decided';
  let confidence: DecisionRecord['confidence'] = 'high';
  const gaps: string[] = [];
  if (!chosen) {
    status = 'conditional';
    confidence = 'low';
    gaps.push(`The chosen model ${chosenKey} is not in the embedding catalogue - it cannot be checked.`);
  } else if (chosen.v.eligibility === 'not_eligible') {
    status = 'conditional';
    confidence = 'low';
    gaps.push(`Data Pipeline Design uses ${chosen.m.label}, which fails a mandatory rule: ${chosen.v.failures.join(' ')} Re-run the design${bestUsable ? ` - ${bestUsable.m.label} is the best model that passes` : ''}.`);
  } else if (chosen.v.eligibility === 'conditional') {
    status = 'conditional';
    confidence = 'medium';
  } else if (nextUsable && Math.abs(chosen.score - nextUsable.score) < confidenceMargin) {
    confidence = 'medium';
  }

  const betterEligible = chosen ? usable.find((e) => e.score > chosen.score && e.v.eligibility === 'eligible' && key(e.m) !== chosenKey) : undefined;
  return {
    phase: 'data_embeddings',
    title: 'Embedding model',
    source: { deliverableId: pipeline.id, version: pipeline.version, createdAt: pipeline.createdAt },
    status,
    recommendation: { id: chosenKey, label: chosen?.m.label ?? chosenKey },
    confidence,
    why: [
      `Chosen in Data Pipeline Design v${pipeline.version} with ${pipeline.chunkingStrategy.replace(/_/g, ' ')} chunking (~${ctx.chunkTokens.toLocaleString()} tokens per chunk).`,
      ...(chosen ? [`Scores ${chosen.score} (quality ${rules.scoringWeights.quality}, cost ${rules.scoringWeights.cost}, dimension efficiency ${rules.scoringWeights.dimensionEfficiency} weights) and is ${chosen.v.eligibility.replace('_', ' ')}.`] : []),
    ],
    candidates,
    alternatives: pickAlternatives(usable.map((e) => ({ id: key(e.m), label: e.m.label, eligibility: e.v.eligibility, reason: `score ${e.score}; ${e.m.dimension} dims, $${e.m.costPerMillionTokens}/1M tokens` })), chosenKey),
    tradeoffs: [
      'Switching embedding model means re-embedding the whole corpus and rebuilding the index; dimensions differ between models.',
      ...(chosen ? [`${chosen.m.dimension}-dimension vectors drive index memory and search cost.`] : []),
    ],
    risks: chosen ? [...chosen.v.failures, ...chosen.v.conditions] : [],
    assumptions: ctx.basis.map((b) => ({ statement: b, evidenceType: 'assumption' as const })),
    evidence: chosen
      ? [
          { label: 'Dimension', value: String(chosen.m.dimension), evidenceType: 'vendor_listed' },
          { label: 'Max input tokens', value: chosen.m.maxInputTokens.toLocaleString(), evidenceType: 'vendor_listed' },
          { label: 'List price', value: `$${chosen.m.costPerMillionTokens} per 1M tokens`, evidenceType: 'vendor_listed' },
          { label: 'Chunk size', value: `~${ctx.chunkTokens.toLocaleString()} tokens`, evidenceType: 'estimated' },
        ]
      : [],
    benchmarkRequired: [
      'Measure retrieval quality (recall@K / nDCG) of the chosen model on a labelled set of the customer\'s own queries - catalogue quality tiers are vendor-level, not domain-specific.',
      ...(chosen?.v.conditions ?? []).map((c) => `Validate: ${c}`),
    ],
    wouldChangeIf: [
      ...(betterEligible ? [`${betterEligible.m.label} scores higher (${betterEligible.score}) and passes every rule - worth evaluating.`] : []),
      'Self-hosting becomes mandatory, multilingual support is required, or chunk size grows past the model\'s input limit.',
    ],
    gaps,
  };
}

// --------------------------------------------------------- Model selection
export function fromModelSelection(ms: AiModelSelection): DecisionRecord {
  const r = ms.result;
  const role = (id: string) => (r.secondary?.id === id ? 'Secondary' : r.fallback?.id === id ? 'Fallback' : null);
  return {
    phase: 'model_selection',
    title: 'Model',
    source: { deliverableId: ms.id, version: ms.version, createdAt: ms.createdAt },
    status: !r.primary ? 'not_feasible' : r.primary.eligibility === 'conditional' ? 'conditional' : 'decided',
    recommendation: r.primary ? { id: r.primary.id, label: r.primary.label } : null,
    confidence: r.confidence,
    why: r.why,
    candidates: r.candidates.map((c) => ({ id: c.id, label: c.label, eligibility: c.eligibility, score: c.score, notes: [...c.failures, ...c.conditions, ...c.notes] })),
    // Secondary and fallback are the spec §7 alternatives; both are always eligible or conditional.
    alternatives: [r.secondary, r.fallback]
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => ({ id: x.id, label: `${role(x.id)}: ${x.label}`, eligibility: x.eligibility, reason: role(x.id) === 'Secondary' ? r.roles.secondary ?? '' : r.roles.fallback ?? '' })),
    tradeoffs: r.tradeoffs,
    risks: r.primary ? [...r.primary.conditions] : [],
    assumptions: Object.entries(ms.sources).map(([k, s]) => ({ statement: `${k}: ${String((ms.requirements as unknown as Record<string, unknown>)[k] ?? '-')} (${s.detail})`, evidenceType: 'assumption' as const })),
    evidence: [
      { label: 'Scoring weights', value: Object.entries(r.weightsUsed).map(([k, v]) => `${k} ${v}`).join(', '), evidenceType: 'assumption' },
      { label: 'Model tiers', value: 'Relative 1-5 planning ratings from config/models.yaml', evidenceType: 'assumption' },
      ...(r.primary ? [{ label: 'Primary score', value: String(r.primary.score), evidenceType: 'estimated' as const }] : []),
    ],
    benchmarkRequired: r.benchmarkRequired,
    wouldChangeIf: r.wouldChangeIf,
    gaps: ['Reranker and speech models are not in the model catalogue yet.'],
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
