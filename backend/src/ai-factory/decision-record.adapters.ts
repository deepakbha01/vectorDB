import { ArchitectureDecisionRecord } from '../vector-db-selection/architecture-decision-record.entity';
import { AssumptionType, EligibilityStatus } from '../recommendation-engine/recommendation.types';
import { IndexDesign } from '../index-design/index-design.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { InferenceAssessment } from '../inference/inference-assessment.entity';
import { DataPipelineDesign } from '../data-pipeline/data-pipeline-design.entity';
import { AiModelSelection } from './model-selection/model-selection.entity';
import { AiInferenceArchitecture } from './inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from './infrastructure/infrastructure.entity';
import { AiRagAgentDesign } from './rag-agent/rag-agent.entity';
import { AiSecurityAssessment } from './security/security.entity';
import { AiPerformanceAssessment } from './performance/performance.entity';
import { AiFinopsAssessment } from './finops/finops.entity';
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
    // Serving technology, patterns and gateway / router design live in the Inference Architecture record (Wave 4).
    gaps: [],
  };
}

// ---------------------------------------------------- Inference architecture
/** Spec §8 Inference Architecture Decision Record, in the standard format. */
export function fromInferenceArchitecture(a: AiInferenceArchitecture): DecisionRecord {
  const r = a.result;
  const arch = r.architecture;
  const alternatives = pickAlternatives(
    r.candidates.map((c) => ({ id: c.id, label: c.label, eligibility: c.eligibility, reason: [...c.conditions, ...c.notes][0] ?? `score ${c.score}` })),
    r.recommended?.id ?? null,
  );
  const missedTargets = (arch?.sla.latency ?? []).filter((l) => l.meetsTargetAtP95 === false).map((l) => `Estimated P95 ${l.metric.toLowerCase()} ${l.p95} ms exceeds the ${l.targetMs} ms target.`);
  return {
    phase: 'inference_architecture',
    title: 'Inference serving architecture',
    source: { deliverableId: a.id, version: a.version, createdAt: a.createdAt },
    status: !r.recommended ? 'not_feasible' : r.recommended.eligibility === 'conditional' ? 'conditional' : 'decided',
    recommendation: r.recommended ? { id: r.recommended.id, label: r.recommended.label } : null,
    confidence: r.confidence,
    why: r.why,
    candidates: r.candidates.map((c) => ({ id: c.id, label: c.label, eligibility: c.eligibility, score: c.score, notes: [...c.failures, ...c.conditions, ...c.notes] })),
    alternatives,
    tradeoffs: [...(arch?.loadBalancing.slice(0, 1) ?? []), ...(arch?.autoscaling.slice(0, 1) ?? []), ...alternatives.map((x) => `${x.label}: ${x.reason}`)],
    risks: r.recommended ? [...r.recommended.conditions, ...missedTargets] : [],
    assumptions: Object.entries(a.sources).map(([k, s]) => ({ statement: `${k}: ${s.detail}`, evidenceType: 'assumption' as const })),
    evidence: [
      ...(arch?.sla.latency.map((l) => ({ label: `${l.metric} P50 / P95 / P99`, value: `${l.p50} / ${l.p95} / ${l.p99} ms`, evidenceType: 'estimated' as const })) ?? []),
      ...(arch?.cost ?? []),
    ],
    benchmarkRequired: r.benchmarkRequired,
    wouldChangeIf: r.wouldChangeIf,
    gaps: [],
  };
}

// ------------------------------------------------------------ Infrastructure
/** Spec §9 Infrastructure Decision Record, in the standard format: the decision is the placement of each component. */
export function fromInfrastructureDesign(d: AiInfrastructureDesign): DecisionRecord {
  const r = d.result;
  const all = r.placements.flatMap((p) => p.candidates.map((c) => ({ id: `${p.component}:${c.target}:${c.platform}`, label: `${p.componentLabel}: ${c.label}`, eligibility: c.eligibility, score: c.score, notes: [...c.failures, ...c.conditions, ...c.notes] })));
  // Alternatives: the best other usable placement for each component, at most two overall (spec §17).
  const alternatives = pickAlternatives(
    r.placements.flatMap((p) => {
      const alt = p.candidates.find((c) => c.eligibility !== 'not_eligible' && (c.target !== p.chosen?.target || c.platform !== p.chosen?.platform));
      return alt ? [{ id: `${p.component}:${alt.target}:${alt.platform}`, label: `${p.componentLabel}: ${alt.label}`, eligibility: alt.eligibility, reason: [...alt.conditions, `score ${alt.score}`][0] }] : [];
    }),
    null,
  );
  return {
    phase: 'infrastructure_design',
    title: 'Infrastructure and deployment',
    source: { deliverableId: d.id, version: d.version, createdAt: d.createdAt },
    status: r.deploymentModel.kind === 'not_feasible' ? 'not_feasible' : r.placements.some((p) => p.chosen?.eligibility === 'conditional') ? 'conditional' : 'decided',
    recommendation: r.deploymentModel.kind === 'not_feasible' ? null : { id: r.deploymentModel.targets.join('+'), label: r.deploymentModel.summary },
    confidence: r.confidence,
    why: r.placements.map((p) => `${p.componentLabel}: ${p.why}`),
    candidates: all,
    alternatives,
    tradeoffs: [...r.sections.availability.slice(0, 2), ...r.sections.network.filter((n) => n.startsWith('Private interconnect'))],
    risks: r.placements.flatMap((p) => (p.chosen?.conditions ?? []).map((c) => `${p.componentLabel}: ${c}`)),
    assumptions: Object.entries(d.sources).map(([k, s]) => ({ statement: `${k}: ${s.detail}`, evidenceType: 'assumption' as const })),
    evidence: r.sizing,
    benchmarkRequired: r.benchmarkRequired,
    wouldChangeIf: r.wouldChangeIf,
    gaps: [],
  };
}

// ------------------------------------------------------- RAG / agent design
/** Spec §10 GenAI Application Architecture in the standard format: one decision per area (retrieval, reranking, agent orchestration). */
export function fromRagAgentDesign(d: AiRagAgentDesign): DecisionRecord {
  const r = d.result;
  const infeasible = r.decisions.some((x) => !x.chosen);
  const alternatives = pickAlternatives(
    r.decisions.flatMap((x) => {
      const alt = x.candidates.find((c) => c.eligibility !== 'not_eligible' && c.id !== x.chosen?.id);
      return alt ? [{ id: `${x.area}:${alt.id}`, label: `${x.title}: ${alt.label}`, eligibility: alt.eligibility, reason: [...alt.conditions, `score ${alt.score}`][0] }] : [];
    }),
    null,
  );
  return {
    phase: 'rag_agent_architecture',
    title: 'RAG / agent architecture',
    source: { deliverableId: d.id, version: d.version, createdAt: d.createdAt },
    status: infeasible ? 'not_feasible' : r.decisions.some((x) => x.chosen?.eligibility === 'conditional') ? 'conditional' : 'decided',
    recommendation: infeasible ? null : { id: r.decisions.map((x) => x.chosen!.id).join('+'), label: r.scope.summary },
    confidence: r.confidence,
    why: r.decisions.map((x) => `${x.title}: ${x.why}`),
    candidates: r.decisions.flatMap((x) => x.candidates.map((c) => ({ id: `${x.area}:${c.id}`, label: `${x.title}: ${c.label}`, eligibility: c.eligibility, score: c.score, notes: [...c.failures, ...c.conditions, ...c.notes] }))),
    alternatives,
    tradeoffs: [r.contextBudget.note, ...r.latencyBudget.lines.filter((l) => l.stage === 'Reranking' || l.stage === 'Agent steps before the answer').map((l) => `${l.stage} adds ~${l.ms.toLocaleString()} ms (${l.detail})`)],
    risks: [...r.decisions.flatMap((x) => (x.chosen?.conditions ?? []).map((c) => `${x.title}: ${c}`)), ...r.gaps],
    assumptions: Object.entries(d.sources).map(([k, s]) => ({ statement: `${k}: ${s.detail}`, evidenceType: 'assumption' as const })),
    evidence: [
      ...r.contextBudget.lines.map((l) => ({ label: `Context: ${l.label}`, value: `${l.tokens.toLocaleString()} tokens`, evidenceType: l.evidenceType })),
      ...r.latencyBudget.lines.map((l) => ({ label: `Latency: ${l.stage}`, value: `${l.ms.toLocaleString()} ms`, evidenceType: l.evidenceType })),
    ],
    benchmarkRequired: r.benchmarkRequired,
    wouldChangeIf: r.wouldChangeIf,
    gaps: r.gaps,
  };
}

// ------------------------------------------------------ Security & governance
const POLICY_ELIGIBILITY = { approved: 'eligible', approved_with_conditions: 'conditional', restricted: 'conditional', not_eligible: 'not_eligible' } as const;

/** Spec §12 AI Security & Governance Assessment in the standard format: the "decision" is the verdict on the chosen architecture. */
export function fromSecurityAssessment(d: AiSecurityAssessment): DecisionRecord {
  const r = d.result;
  const v = r.validation.status;
  return {
    phase: 'security_governance',
    title: 'Security and governance',
    source: { deliverableId: d.id, version: d.version, createdAt: d.createdAt },
    status: v === 'fail' ? 'not_feasible' : v === 'pass' ? 'decided' : 'conditional',
    recommendation: { id: r.overall.status, label: `${r.overall.label} - security validation: ${v.replace(/_/g, ' ')}` },
    confidence: d.context.missingDesigns.length ? 'low' : r.gaps.length ? 'medium' : 'high',
    why: [r.overall.summary, ...r.validation.reasons],
    candidates: r.components.map((c) => ({ id: c.id, label: `${c.label}: ${c.choice}`, eligibility: POLICY_ELIGIBILITY[c.status], score: null, notes: [...c.reasons, ...c.conditions] })),
    // An assessment, not a choice between options - alternatives live in the phases that made each choice.
    alternatives: [],
    tradeoffs: r.components.filter((c) => c.status === 'restricted').map((c) => `${c.label} (${c.choice}) is usable only for non-restricted data.`),
    risks: [...r.components.flatMap((c) => c.conditions.map((k) => `${c.label}: ${k}`)), ...r.gaps],
    assumptions: Object.entries(d.sources).map(([k, s]) => ({ statement: `${k}: ${s.detail}`, evidenceType: 'assumption' as const })),
    evidence: r.controls.filter((c) => c.status === 'addressed').map((c) => ({ label: c.label, value: c.designedIn.map((s) => s.source).filter((s, i, a) => a.indexOf(s) === i).join('; '), evidenceType: 'assumption' as const })),
    benchmarkRequired: r.verificationRequired,
    wouldChangeIf: r.wouldChangeIf,
    gaps: r.gaps,
  };
}

// ------------------------------------------------------ Performance & benchmark
const METRIC_ELIGIBILITY = { pass: 'eligible', pass_with_conditions: 'conditional', fail: 'not_eligible', requires_benchmark: 'not_assessed', not_applicable: 'not_assessed' } as const;

/** Spec §11 Performance & Benchmark Assessment in the standard format: the verdict on the chosen architecture, measured evidence only. */
export function fromPerformanceAssessment(d: AiPerformanceAssessment): DecisionRecord {
  const r = d.result;
  const metrics = r.groups.flatMap((g) => g.metrics).filter((m) => m.status !== 'not_applicable');
  const unit = (v: number, u: string) => `${v}${u ? (u === '%' ? '%' : ` ${u}`) : ''}`;
  return {
    phase: 'performance_benchmark',
    title: 'Performance and benchmark',
    source: { deliverableId: d.id, version: d.version, createdAt: d.createdAt },
    status: r.status.status === 'fail' ? 'not_feasible' : r.status.status === 'pass' ? 'decided' : 'conditional',
    recommendation: { id: r.status.status, label: r.status.label },
    // Confidence reflects how much is measured, not how good the estimates look.
    confidence: r.counts.requires_benchmark === 0 ? 'high' : r.counts.pass + r.counts.pass_with_conditions + r.counts.fail > 0 ? 'medium' : 'low',
    why: r.status.reasons,
    candidates: metrics.map((m) => ({ id: m.id, label: m.label, eligibility: METRIC_ELIGIBILITY[m.status], score: null, notes: [...m.reasons, ...m.conditions] })),
    alternatives: [],
    tradeoffs: [],
    risks: metrics.filter((m) => m.status === 'fail' || (m.status === 'requires_benchmark' && m.estimateMeetsTarget === false)).map((m) => `${m.label}: ${m.reasons[m.reasons.length - 1]}`),
    assumptions: metrics.filter((m) => m.target?.assumed).map((m) => ({ statement: `${m.label} target ${unit(m.target!.value, m.unit)} - ${m.target!.source}`, evidenceType: 'assumption' as const })),
    evidence: [
      ...metrics.filter((m) => m.measured).map((m) => ({ label: m.label, value: `${unit(m.measured!.value, m.unit)} (${m.measured!.source})`, evidenceType: 'measured' as const })),
      ...metrics.filter((m) => !m.measured && m.estimate).map((m) => ({ label: m.label, value: `${unit(m.estimate!.value, m.unit)} (${m.estimate!.source})`, evidenceType: m.estimate!.evidenceType })),
    ],
    benchmarkRequired: r.benchmarkPlan.map((b) => `${b.metric}: ${b.how}${b.warning ? ` - ${b.warning}` : ''}`),
    wouldChangeIf: ['Recording measured results (with their source) turns REQUIRES BENCHMARK into PASS / PASS WITH CONDITIONS / FAIL.'],
    gaps: r.gaps,
  };
}

// ------------------------------------------------------------ Cost & FinOps
/** Spec §13 Cost & FinOps Assessment in the standard format: the chosen design's cost, with cheaper allowed options as alternatives. */
export function fromFinopsAssessment(d: AiFinopsAssessment): DecisionRecord {
  const r = d.result;
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const options = r.comparison.map((o) => ({
    id: o.id,
    label: o.label,
    eligibility: (!o.feasible ? 'not_eligible' : o.allowed ? 'eligible' : 'conditional') as Eligibility,
    monthlyUsd: o.monthlyUsd,
    note: !o.feasible ? o.notFeasibleReasons.join(' ') : o.allowed ? `${money(o.monthlyUsd!)} / month` : `${money(o.monthlyUsd!)} / month - not an allowed target`,
  }));
  const chosenMonthly = r.chosen?.monthlyUsd ?? null;
  const cheaper = options.filter((o) => o.eligibility !== 'not_eligible' && o.monthlyUsd !== null && chosenMonthly !== null && o.monthlyUsd < chosenMonthly && o.id !== 'hybrid').sort((a, b) => a.monthlyUsd! - b.monthlyUsd!);
  return {
    phase: 'finops',
    title: 'Cost and FinOps',
    source: { deliverableId: d.id, version: d.version, createdAt: d.createdAt },
    status: r.validation.status === 'fail' ? 'not_feasible' : 'conditional',
    recommendation: r.chosen?.monthlyUsd ? { id: 'chosen', label: `${r.chosen.label}: ~${money(r.chosen.monthlyUsd)} / month (estimate)` } : null,
    // Cost estimates never earn high confidence without a rate card or quotes.
    confidence: r.chosen?.feasible ? 'medium' : 'low',
    why: [...r.validation.reasons, r.disclaimer],
    candidates: options.map((o) => ({ id: o.id, label: o.label, eligibility: o.eligibility, score: null, notes: [o.note] })),
    alternatives: pickAlternatives(cheaper.map((o) => ({ id: o.id, label: o.label, eligibility: o.eligibility, reason: o.note })), null),
    tradeoffs: r.wouldChangeIf,
    risks: [...(r.budget.status === 'exceeds_budget' || r.budget.status === 'near_budget' ? [r.budget.note] : []), ...r.gaps],
    assumptions: (r.chosen?.lines ?? []).filter((l) => l.evidenceType === 'assumption').map((l) => ({ statement: `${l.item}: ${l.basis}`, evidenceType: 'assumption' as const })),
    evidence: [
      ...(r.chosen?.lines ?? []).map((l) => ({ label: l.item, value: `${money(l.monthlyUsd)} / month`, evidenceType: l.evidenceType })),
      ...r.oneOff.map((o) => ({ label: o.item, value: `${money(o.usd)} one-off`, evidenceType: o.evidenceType })),
    ],
    benchmarkRequired: ['Replace the assumed rate card with contracted rates or vendor quotes', 'Confirm with a billed pilot before committing to a budget'],
    wouldChangeIf: r.wouldChangeIf,
    gaps: r.gaps,
  };
}
