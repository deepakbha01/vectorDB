import { CatalogueModel, EvaluatedModel, ModelCatalogue, ModelRequirements, ModelSelectionResult } from './model-selection.types';

const CAPABILITY_LABEL: Record<string, string> = {
  tool_calling: 'tool / function calling',
  structured_output: 'structured (JSON) output',
  multilingual: 'multilingual support',
  vision: 'image / multimodal input',
  code: 'code generation',
};
const fmt = (n: number) => n.toLocaleString('en-US');
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Spec §3 order for one candidate: mandatory requirements first (a failure
 * makes it NOT ELIGIBLE, whatever it would score), then conditions that keep
 * it eligible only with validation or contractual safeguards (CONDITIONAL).
 */
export function checkEligibility(m: CatalogueModel, req: ModelRequirements, cat: ModelCatalogue): Pick<EvaluatedModel, 'eligibility' | 'failures' | 'conditions' | 'notes'> {
  const failures: string[] = [];
  const conditions: string[] = [];
  const notes: string[] = [];
  const has = (c: string) => m.capabilities.includes(c as never);
  const licence = cat.licences[m.licence];

  if (m.contextWindow < req.requiredContextTokens) failures.push(`Context window ${fmt(m.contextWindow)} tokens is below the ${fmt(req.requiredContextTokens)} required.`);
  if (req.multimodal && !has('vision')) failures.push(`No ${CAPABILITY_LABEL.vision}, required for multimodal data.`);
  if (req.toolCalling && !has('tool_calling')) failures.push(`No ${CAPABILITY_LABEL.tool_calling}, required for agent / copilot workloads.`);
  if (req.structuredOutput && !has('structured_output')) failures.push(`No ${CAPABILITY_LABEL.structured_output}.`);
  if (req.multilingual && !has('multilingual')) failures.push(`No ${CAPABILITY_LABEL.multilingual}.`);
  if (req.selfHostingRequired && m.family === 'proprietary_api') failures.push('Only available as a third-party API, but the model must run inside the customer boundary.');
  if (req.fineTuning !== 'none' && !m.fineTunable) failures.push(`Cannot be fine-tuned (${req.fineTuning} fine-tuning required).`);
  if (req.permissiveLicenceOnly && !licence?.permissive) failures.push(`Licence (${licence?.label ?? m.licence}) is not permissive, and only permissive licences are allowed.`);
  if (req.maxSelfHostedParamsB !== undefined && m.family === 'open_weight' && (m.paramsB ?? 0) > req.maxSelfHostedParamsB) {
    failures.push(`${m.paramsB}B parameters exceeds the ${req.maxSelfHostedParamsB}B that available GPU capacity allows.`);
  }

  if (req.codeGeneration && !has('code')) conditions.push(`Not tuned for ${CAPABILITY_LABEL.code} - evaluate on the customer's code tasks.`);
  if (m.qualityTier < cat.accuracyMinQualityTier[req.accuracyRequirement]) {
    conditions.push(`Relative quality tier ${m.qualityTier} is below the ${cat.accuracyMinQualityTier[req.accuracyRequirement]} expected for ${req.accuracyRequirement} accuracy - must pass the customer evaluation set.`);
  }
  if (m.reasoningTier < cat.reasoningMinTier[req.reasoningComplexity]) {
    conditions.push(`Reasoning tier ${m.reasoningTier} is below the ${cat.reasoningMinTier[req.reasoningComplexity]} expected for ${req.reasoningComplexity}-complexity reasoning - benchmark multi-step tasks.`);
  }
  if (req.restrictedData && m.family === 'proprietary_api') {
    conditions.push('Restricted data (PHI / PCI) may only be sent under a signed BAA / DPA with zero data retention, in an approved region.');
  }

  if (licence && !licence.permissive) notes.push(`Licence: ${licence.label} - ${licence.note}`);
  if (m.contextWindow < req.requiredContextTokens * 2 && m.contextWindow >= req.requiredContextTokens) notes.push('Little context headroom beyond the stated requirement.');

  return { eligibility: failures.length ? 'not_eligible' : conditions.length ? 'conditional' : 'eligible', failures, conditions, notes };
}

/** Re-normalised weights after priority multipliers. */
export function effectiveWeights(req: ModelRequirements, cat: ModelCatalogue): Record<string, number> {
  const w: Record<string, number> = { ...cat.scoringWeights };
  if (req.latencyPriority === 'high') w.latency *= cat.priorityMultiplier;
  if (req.costPriority === 'high') w.cost *= cat.priorityMultiplier;
  if (req.accuracyRequirement === 'critical') w.quality *= cat.priorityMultiplier;
  if (req.reasoningComplexity === 'high') w.reasoning *= cat.priorityMultiplier;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, round(v / total)]));
}

export function scoreModel(m: CatalogueModel, req: ModelRequirements, weights: Record<string, number>): { score: number; criteria: Record<string, number> } {
  // Tiers are relative 1-5 ratings; falling below a required tier is handled as a condition in checkEligibility, not here.
  const criteria = {
    quality: m.qualityTier / 5,
    reasoning: m.reasoningTier / 5,
    latency: m.latencyTier / 5,
    cost: m.costTier / 5,
    contextHeadroom: Math.min(1, m.contextWindow / Math.max(1, req.requiredContextTokens * 4)),
    // Neutral between families: self-hostable weights can ALSO be consumed via managed endpoints; API tiers cannot be self-hosted.
    deploymentFlexibility: m.family === 'open_weight' ? 1 : 0.6,
  };
  const score = Object.entries(criteria).reduce((sum, [k, v]) => sum + v * (weights[k] ?? 0), 0);
  return { score: round(score), criteria: Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, round(v)])) };
}

/** Scores this close are treated as a tie and broken by a stated, deterministic rule. */
const TIE_EPSILON = 0.001;

/**
 * Model Selection (spec §7): eligibility → weighted scoring → primary,
 * secondary and fallback, with confidence, trade-offs and what would change
 * the decision. Pure; every rule and tier comes from config/models.yaml.
 */
export function selectModels(req: ModelRequirements, cat: ModelCatalogue): ModelSelectionResult {
  const weights = effectiveWeights(req, cat);
  const ctxOf = (id: string) => cat.models.find((m) => m.id === id)?.contextWindow ?? 0;
  const candidates: EvaluatedModel[] = cat.models
    .map((m) => ({
      id: m.id,
      label: m.label,
      family: m.family,
      ...checkEligibility(m, req, cat),
      ...scoreModel(m, req, weights),
      inferenceModelId: m.inferenceModelId,
      managedApiTierId: m.managedApiTierId,
    }))
    // Band first (eligibility - an ineligible model can never outrank), then score; exact ties go to the larger context window, then the id (never array order).
    .sort((a, b) => band(a) - band(b) || (Math.abs(b.score - a.score) > TIE_EPSILON ? b.score - a.score : ctxOf(b.id) - ctxOf(a.id) || a.id.localeCompare(b.id)));

  const usable = candidates.filter((c) => c.eligibility !== 'not_eligible');
  const primary = usable[0] ?? null;
  // Secondary: best usable model from the OTHER deployment family, so the design keeps a portability / sovereignty path; else the runner-up.
  const otherFamily = primary ? usable.find((c) => c.id !== primary.id && c.family !== primary.family) : undefined;
  const secondary = otherFamily ?? usable.find((c) => c.id !== primary?.id) ?? null;
  // Fallback: the fastest, cheapest usable model left - for degraded mode and routing simple requests.
  const fallback =
    usable
      .filter((c) => c.id !== primary?.id && c.id !== secondary?.id)
      .sort((a, b) => b.criteria.latency + b.criteria.cost - (a.criteria.latency + a.criteria.cost) || b.score - a.score)[0] ?? null;

  const runnerUp = usable[1];
  // Eligible candidates sort first, so a conditional primary means nothing usable is free of conditions.
  const confidence: ModelSelectionResult['confidence'] = !primary
    ? 'low'
    : primary.eligibility === 'conditional' || (runnerUp && primary.score - runnerUp.score < cat.confidenceMargin)
      ? 'medium'
      : 'high';

  const why: string[] = [];
  if (!primary) {
    why.push('No model in the catalogue meets every mandatory requirement - relax a requirement (see below) or add a candidate to config/models.yaml.');
  } else {
    // Eligible candidates rank before conditional ones, so a conditional model can out-score the primary - say so rather than claim "highest score".
    const outscoringConditional = usable.filter((c) => c.eligibility === 'conditional' && c.score > primary.score);
    if (primary.eligibility === 'eligible' && outscoringConditional.length) {
      const best = outscoringConditional.sort((a, b) => b.score - a.score)[0];
      why.push(`${primary.label} is the highest-scoring model that meets every requirement without conditions (${primary.score}); ${candidates.length - usable.length} candidate(s) failed a mandatory requirement.`);
      why.push(`${best.label} scores higher (${best.score}) but only with conditions: ${best.conditions[0]}`);
    } else if (runnerUp && runnerUp.eligibility === primary.eligibility && Math.abs(primary.score - runnerUp.score) <= TIE_EPSILON) {
      const [pc, rc] = [ctxOf(primary.id), ctxOf(runnerUp.id)];
      why.push(`${primary.label} and ${runnerUp.label} are tied at ${primary.score} among ${usable.length} usable candidate(s) after ${candidates.length - usable.length} failed a mandatory requirement.`);
      why.push(pc !== rc ? `Tie broken by the larger context window (${fmt(pc)} vs ${fmt(rc)} tokens) - treat the two as interchangeable and let the evaluation decide.` : `Tie broken alphabetically (identical score and context window) - treat the two as interchangeable and let the evaluation decide.`);
    } else {
      why.push(`${primary.label} has the highest weighted score (${primary.score}) among ${usable.length} usable candidate(s) after ${candidates.length - usable.length} failed a mandatory requirement.`);
    }
    const top = Object.entries(primary.criteria).sort((a, b) => b[1] * weights[b[0]] - a[1] * weights[a[0]]).slice(0, 2).map(([k]) => k);
    why.push(`Strongest contributions: ${top.join(' and ')}.`);
    if (primary.eligibility === 'conditional') why.push(`Recommended with conditions: ${primary.conditions.join(' ')}`);
  }

  const outscoredButIneligible = candidates
    .filter((c) => c.eligibility === 'not_eligible' && primary && c.score > primary.score)
    .map((c) => `${c.label} would score higher (${c.score}) but is not eligible: ${c.failures[0]}`);
  const outscoredButConditional = candidates
    .filter((c) => c.eligibility === 'conditional' && primary?.eligibility === 'eligible' && c.score > primary.score)
    .map((c) => `${c.label} would be preferred (${c.score}) if its conditions are accepted: ${c.conditions[0]}`);
  const wouldChangeIf = [
    ...outscoredButIneligible,
    ...outscoredButConditional,
    ...(runnerUp && primary ? [`${runnerUp.label} is within ${round(primary.score - runnerUp.score)} - a change in latency, cost or accuracy priority could swap them.`] : []),
    ...(req.selfHostingRequired ? ['Allowing a third-party API would add the managed API tiers as candidates.'] : []),
    'The customer evaluation set shows a different quality ranking than the relative tiers used here.',
  ];

  const tradeoffs = [
    ...(primary && secondary ? [`Secondary ${secondary.label} (${secondary.family === 'open_weight' ? 'self-hostable' : 'managed API'}) keeps an alternative deployment path at score ${secondary.score}.`] : []),
    ...(fallback ? [`Fallback ${fallback.label} is the fastest / cheapest usable option - use it for degraded mode or routing simple requests.`] : []),
    ...(primary?.notes ?? []),
  ];

  const benchmarkRequired = [
    'Run the customer evaluation set (accuracy, groundedness, format compliance) on the primary and secondary before committing - quality tiers here are relative planning ratings, not measurements.',
    ...(primary?.conditions ?? []).map((c) => `Validate: ${c}`),
    ...(primary ? ['Size and load-test serving for the chosen model in the Inference assessment (Phase 5) - model choice does not fix the inference architecture.'] : []),
  ];

  return {
    rulesVersion: cat.rulesVersion,
    primary,
    secondary,
    fallback,
    roles: {
      secondary: secondary ? (otherFamily ? 'Alternative deployment family (portability / sovereignty)' : 'Runner-up') : null,
      fallback: fallback ? 'Fastest / cheapest usable model (degraded mode, simple-request routing)' : null,
    },
    confidence,
    candidates,
    why,
    tradeoffs,
    wouldChangeIf,
    benchmarkRequired,
    weightsUsed: weights,
  };
}

function band(c: EvaluatedModel): number {
  return c.eligibility === 'eligible' ? 0 : c.eligibility === 'conditional' ? 1 : 2;
}
