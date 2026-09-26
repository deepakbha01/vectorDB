import { DecisionRecord, PhaseKey, StateSection } from '../ai-factory.types';
import { AdrSection, ArchitectureAlternative, ChainStep, FinalInputs, FinalResult, GateStage, GateStageKey, Readiness, StageStatus, TechnicalRecommendation } from './final.types';

export const FINAL_RULES_VERSION = 'final-2026.09-1';
const READINESS_LABEL: Record<Readiness, string> = {
  production_ready: 'PRODUCTION READY',
  ready_with_conditions: 'PRODUCTION READY WITH CONDITIONS',
  further_assessment: 'REQUIRES FURTHER ASSESSMENT',
  not_suitable: 'NOT SUITABLE',
};
const STAGE_LABEL: Record<GateStageKey, string> = {
  data: 'Data validation',
  requirements: 'Requirement validation',
  security: 'Security validation',
  technology: 'Technology eligibility',
  performance: 'Performance validation',
  cost: 'Cost validation',
  operations: 'Operational validation',
};
const RANK: Record<StageStatus, number> = { pass: 0, pass_with_conditions: 1, further_assessment: 2, fail: 3 };
const worst = (a: StageStatus, b: StageStatus) => (RANK[a] >= RANK[b] ? a : b);
/** The technology choices the final architecture is built from. */
const TECH_PHASES: PhaseKey[] = ['data_embeddings', 'index_design', 'vector_db_selection', 'model_selection', 'inference_architecture', 'infrastructure_design', 'rag_agent_architecture'];
/** Order in which a different choice changes the architecture most. */
const ALTERNATIVE_PRIORITY: PhaseKey[] = ['vector_db_selection', 'model_selection', 'inference_architecture', 'infrastructure_design', 'rag_agent_architecture', 'data_embeddings', 'index_design'];

const str = (v: unknown, fallback = 'not decided') => (v === null || v === undefined || v === '' ? fallback : Array.isArray(v) ? v.join(', ') : String(v));

/** Production readiness gate (spec §25): each stage from the phases that validate it; out-of-date inputs never pass. */
export function readinessGate(x: FinalInputs): FinalResult['readiness'] {
  const phase = (k: PhaseKey) => x.lineage.find((l) => l.phase === k);
  const decision = (k: PhaseKey) => x.decisions.find((d) => d.phase === k);
  const stage = (key: GateStageKey, phases: PhaseKey[], base: { status: StageStatus; reasons: string[] }): GateStage => {
    let status = base.status;
    const reasons = [...base.reasons];
    const missing = phases.filter((p) => !phase(p)?.latest);
    const stale = phases.filter((p) => phase(p)?.status === 'stale');
    if (missing.length) {
      status = worst(status, 'further_assessment');
      reasons.push(`Not done yet: ${missing.map((p) => phase(p)?.label ?? p).join(', ')}.`);
    }
    if (stale.length) {
      status = worst(status, 'further_assessment');
      reasons.push(`Out of date - re-run: ${stale.map((p) => phase(p)?.label ?? p).join(', ')}.`);
    }
    return { stage: key, label: STAGE_LABEL[key], status, reasons, phases };
  };
  const fromValidation = (v: unknown, what: string): { status: StageStatus; reasons: string[] } => {
    const s = String(v ?? '');
    if (s === 'pass') return { status: 'pass', reasons: [`${what}: pass.`] };
    if (s === 'pass_with_conditions') return { status: 'pass_with_conditions', reasons: [`${what}: pass with conditions.`] };
    if (s === 'fail') return { status: 'fail', reasons: [`${what}: fail.`] };
    if (s === 'requires_benchmark') return { status: 'further_assessment', reasons: [`${what}: requires benchmark evidence.`] };
    return { status: 'further_assessment', reasons: [s ? `${what}: requires further assessment.` : `${what}: not assessed yet.`] };
  };
  const summary = (s: StateSection) => s.summary as Record<string, unknown>;

  // Data: the inputs every later phase stands on.
  const profileIncomplete = summary(x.state.useCase).profileStatus === 'incomplete';
  const data = stage('data', ['discovery', 'workload_profile', 'data_embeddings'], profileIncomplete ? { status: 'further_assessment', reasons: ['The AI Workload Profile has missing inputs.'] } : { status: 'pass', reasons: ['Discovery, Workload Profile and Data & Embedding design are in place.'] });

  // Requirements: gaps the phases reported against the stated requirements.
  const withGaps = x.decisions.filter((d) => d.gaps.length);
  const requirements = stage(
    'requirements',
    ['discovery', 'workload_profile'],
    withGaps.length
      ? { status: 'pass_with_conditions', reasons: withGaps.map((d) => `${d.title}: ${d.gaps.length} open gap(s) - ${d.gaps[0]}`) }
      : { status: 'pass', reasons: ['No phase reports a requirement it cannot meet.'] },
  );

  // Technology: every chosen option is eligible.
  const techRecords = TECH_PHASES.map(decision).filter((d): d is DecisionRecord => !!d);
  const infeasible = techRecords.filter((d) => d.status === 'not_feasible');
  const conditional = techRecords.filter((d) => d.status === 'conditional');
  const technology = stage(
    'technology',
    TECH_PHASES,
    infeasible.length
      ? { status: 'fail', reasons: infeasible.map((d) => `${d.title}: no eligible option.`) }
      : conditional.length
        ? { status: 'pass_with_conditions', reasons: conditional.map((d) => `${d.title}: ${d.recommendation?.label ?? 'chosen option'} is eligible with conditions.`) }
        : { status: 'pass', reasons: ['Every chosen technology meets its mandatory requirements.'] },
  );

  const stages: GateStage[] = [
    data,
    requirements,
    stage('security', ['security_governance'], fromValidation(summary(x.state.security).validation, 'Security & Governance')),
    technology,
    stage('performance', ['performance_benchmark'], fromValidation(summary(x.state.performance).statusKey, 'Performance & Benchmark')),
    x.tokenObservability
      ? stage('cost', ['finops', 'token_observability'], combine(fromValidation(summary(x.state.cost).validation, 'Cost & FinOps'), tokenEvidence(x.state.tokenObservability)))
      : stage('cost', ['finops'], fromValidation(summary(x.state.cost).validation, 'Cost & FinOps')),
    stage('operations', ['operations_model'], fromValidation(summary(x.state.operations).verdict, 'Operations model')),
  ];

  const status: Readiness = stages.some((s) => s.status === 'fail')
    ? 'not_suitable'
    : stages.some((s) => s.status === 'further_assessment')
      ? 'further_assessment'
      : stages.some((s) => s.status === 'pass_with_conditions')
        ? 'ready_with_conditions'
        : 'production_ready';
  const reasons =
    status === 'production_ready'
      ? ['Every gate stage passes on current, measured evidence.']
      : stages.filter((s) => s.status === (status === 'not_suitable' ? 'fail' : status === 'further_assessment' ? 'further_assessment' : 'pass_with_conditions')).map((s) => `${s.label}: ${s.reasons.join(' ')}`);
  return { status, label: READINESS_LABEL[status], reasons, stages };
}

/** Spec §16 / §24 explainability for one decision record. */
export function explain(d: DecisionRecord, outOfDate: boolean): TechnicalRecommendation {
  const chosen = d.candidates.find((c) => c.id === d.recommendation?.id);
  const satisfied =
    d.status === 'not_feasible'
      ? []
      : [chosen?.eligibility === 'conditional' || d.status === 'conditional' ? `Mandatory requirements for ${d.title.toLowerCase()} - met with conditions` : `All mandatory requirements for ${d.title.toLowerCase()}`];
  return {
    phase: d.phase,
    title: d.title,
    recommendation: d.recommendation?.label ?? null,
    status: d.status,
    confidence: d.confidence,
    outOfDate,
    why: d.why,
    satisfied,
    partiallySatisfied: d.risks,
    notSatisfied: d.status === 'not_feasible' ? [...d.why.slice(0, 1), ...d.gaps] : d.gaps,
    tradeoffs: d.tradeoffs,
    assumptions: d.assumptions.map((a) => a.statement),
    evidence: d.evidence.map((e) => `${e.label}: ${e.value} (${e.evidenceType.replace('_', '-')})`),
    benchmarkRequired: d.benchmarkRequired,
    wouldChangeIf: d.wouldChangeIf,
  };
}

/** Spec §17: up to two architecture alternatives, never one that fails a mandatory requirement. */
export function architectureAlternatives(x: FinalInputs): FinalResult['alternatives'] {
  const options: ArchitectureAlternative[] = [];
  const cost = x.decisions.find((d) => d.phase === 'finops');
  for (const phase of ALTERNATIVE_PRIORITY) {
    const d = x.decisions.find((r) => r.phase === phase);
    const alt = d?.alternatives.find((a) => a.eligibility !== 'not_eligible');
    if (!d || !alt || options.length >= 2) continue;
    const candidate = d.candidates.find((c) => c.id === alt.id);
    const costed = cost?.candidates.find((c) => phase === 'infrastructure_design' && alt.label.includes(c.label.split(' ')[0]));
    options.push({
      label: alt.label,
      replaces: `${d.title}: ${d.recommendation?.label ?? 'current choice'}`,
      eligibility: alt.eligibility,
      strengths: candidate ? [`Score ${candidate.score ?? 'n/a'} in ${d.title}`, ...candidate.notes.filter((n) => !/conditional|needs|requires|must/i.test(n)).slice(0, 2)] : [`Usable alternative in ${d.title}`],
      limitations: candidate ? candidate.notes.filter((n) => /conditional|needs|requires|must|not /i.test(n)).slice(0, 3) : [alt.reason],
      deployment: phase === 'infrastructure_design' ? alt.label : 'Within the chosen deployment',
      costConsiderations: costed ? `${costed.notes[0]} (Cost & FinOps)` : 'Not priced separately - re-run Cost & FinOps if chosen.',
      risks: alt.eligibility === 'conditional' ? [alt.reason] : [],
      whenToChoose: d.wouldChangeIf[0] ?? `If the reason for the current ${d.title.toLowerCase()} choice no longer holds.`,
      sourcePhase: phase,
    });
  }
  const primary = x.decisions.filter((d) => TECH_PHASES.includes(d.phase) && d.recommendation).map((d) => `${d.title}: ${d.recommendation!.label}`).join(' · ');
  return { primary: primary || 'No architecture decided yet', options, note: options.length < 2 ? `Only ${options.length} eligible alternative(s) exist across the decisions - the others fail a mandatory requirement or were not assessed.` : null };
}

/** Combines every phase into the final recommendation (spec §15-§18, §25, §26). Pure. */
export function buildFinalRecommendation(x: FinalInputs): FinalResult {
  const s = x.state;
  const S = (k: keyof typeof s) => s[k].summary as Record<string, any>;
  const lin = (k: PhaseKey) => x.lineage.find((l) => l.phase === k);
  const status = (k: PhaseKey | null): ChainStep['status'] => (!k || !lin(k)?.latest ? 'missing' : lin(k)!.status === 'stale' ? 'stale' : 'current');
  // Sections that summarise across phases have no single source to be missing or stale.
  const sectionStatus = (k: PhaseKey | null): AdrSection['status'] => (k ? status(k) : 'current');
  const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : str(v, '?'));
  const readiness = readinessGate(x);
  const decisions = x.decisions;
  const d = (k: PhaseKey) => decisions.find((r) => r.phase === k);

  const technical = decisions.filter((r) => r.phase !== 'discovery').map((r) => explain(r, lin(r.phase)?.status === 'stale'));

  const rag = S('rag').decisions as Record<string, string> | undefined;
  const architecture: ChainStep[] = [
    { step: 'Use case', component: str(S('useCase').businessObjective ?? S('useCase').businessUseCase ?? x.projectName), source: 'workload_profile', status: status('workload_profile') },
    { step: 'Data sources', component: str(S('useCase').dataSources, 'not stated'), source: 'workload_profile', status: status('workload_profile') },
    { step: 'Ingestion', component: 'Ingestion pipeline (Data & Embedding design)', source: 'data_embeddings', status: status('data_embeddings') },
    { step: 'Chunking', component: S('data').chunkingStrategy ? `${S('data').chunkingStrategy} · ${S('data').chunkSize}` : 'not decided', source: 'data_embeddings', status: status('data_embeddings') },
    { step: 'Embedding', component: str(S('embedding').model), source: 'data_embeddings', status: status('data_embeddings') },
    { step: 'VectorDB', component: str(S('vectorDB').projectPlatform && S('vectorDB').projectPlatform !== 'undetermined' ? S('vectorDB').projectPlatform : S('vectorDB').platform), source: 'vector_db_selection', status: status('vector_db_selection') },
    { step: 'Index', component: str(S('index').index), source: 'index_design', status: status('index_design') },
    { step: 'Reranker', component: rag?.Reranking ?? 'not designed', source: 'rag_agent_architecture', status: status('rag_agent_architecture') },
    { step: 'LLM / SLM', component: S('model').primary ? `${S('model').primary}${S('model').fallback ? ` (fallback ${S('model').fallback})` : ''}` : 'not selected', source: 'model_selection', status: status('model_selection') },
    { step: 'Inference serving', component: str(S('inference').servingRuntime ?? S('inference').recommended), source: 'inference_architecture', status: status('inference_architecture') },
    { step: 'AI application', component: str(S('rag').scope, 'not designed'), source: 'rag_agent_architecture', status: status('rag_agent_architecture') },
    { step: 'Security', component: S('security').overall ? `${S('security').overall} (${S('security').validation})` : 'not assessed', source: 'security_governance', status: status('security_governance') },
    { step: 'Monitoring', component: S('operations').verdict ? `Operations model: ${S('operations').verdict}` : 'not modelled', source: 'operations_model', status: status('operations_model') },
    { step: 'FinOps', component: S('cost').chosenMonthlyUsd ? `~$${Math.round(S('cost').chosenMonthlyUsd).toLocaleString()} / month (estimate)` : 'not priced', source: 'finops', status: status('finops') },
  ];

  const alternatives = architectureAlternatives(x);

  const confidences = decisions.filter((r) => TECH_PHASES.includes(r.phase)).map((r) => r.confidence);
  const confidence: FinalResult['executiveSummary']['confidence'] =
    readiness.status === 'not_suitable' || !confidences.length || confidences.includes('low') || confidences.includes('not_assessed') ? 'low' : confidences.includes('medium') || readiness.status !== 'production_ready' ? 'medium' : 'high';
  const keyRisks = [
    ...readiness.stages.filter((g) => g.status === 'fail').map((g) => `${g.label}: ${g.reasons[0]}`),
    ...decisions.flatMap((r) => r.risks.slice(0, 1).map((k) => `${r.title}: ${k}`)),
  ].slice(0, 6);

  const executiveSummary: FinalResult['executiveSummary'] = {
    useCase: str(S('useCase').businessObjective ?? S('useCase').businessUseCase ?? x.projectName),
    recommendedArchitecture: str(S('scale').architecture ?? S('rag').scope, 'not classified'),
    deployment: str(S('infrastructure').deploymentModel, 'not designed'),
    primaryModel: str(S('model').primary, 'not selected'),
    vectorDb: architecture[5].component,
    inferenceArchitecture: architecture[9].component,
    estimatedScale: S('scale').workloadSize ? `${String(S('scale').workloadSize).replace(/_/g, ' ')} - ${num(S('scale').expectedVectorCount)} vectors, ${num(S('scale').dailyRequests)} requests / day, peak ${num(S('scale').peakQps)} QPS` : 'not profiled',
    keyRisks,
    confidence,
  };

  const line = (label: string, v: unknown) => `${label}: ${str(v)}`;
  const sec = (number: number, title: string, source: PhaseKey | null, lines: string[]): AdrSection => ({ number, title, lines: status(source) === 'missing' && source ? [`Not assessed yet - complete ${lin(source)?.label ?? source}.`] : lines, source, status: sectionStatus(source) });
  const rec = (k: PhaseKey) => (d(k)?.recommendation ? [`Recommendation: ${d(k)!.recommendation!.label}`, ...d(k)!.why.slice(0, 3)] : []);
  const adr: AdrSection[] = [
    sec(1, 'Executive summary', null, [readiness.label, `Use case: ${executiveSummary.useCase}`, `Architecture: ${executiveSummary.recommendedArchitecture}; deployment: ${executiveSummary.deployment}`, `Primary model: ${executiveSummary.primaryModel}; vector DB: ${executiveSummary.vectorDb}`, `Confidence: ${confidence}`]),
    sec(2, 'Business objective', 'workload_profile', [line('Objective', S('useCase').businessObjective), line('Domain', S('useCase').businessDomain), line('Criticality', S('useCase').businessCriticality), line('Expected users', S('useCase').expectedUsers)]),
    sec(3, 'AI use case', 'workload_profile', [line('Workload types', S('useCase').workloadTypes), line('Architecture class', S('scale').architecture), line('Data sources', S('useCase').dataSources)]),
    sec(4, 'Workload profile', 'workload_profile', [line('Size', S('scale').workloadSize), line('Data classification', S('scale').dataClassification), line('Deployment targets', S('scale').deploymentTargets), line('Availability target', S('scale').availabilityTargetPercent)]),
    sec(5, 'Data architecture', 'data_embeddings', [line('Chunking', S('data').chunkingStrategy), line('Chunk size', S('data').chunkSize), line('Metadata fields', S('data').metadataFields)]),
    sec(6, 'Embedding strategy', 'data_embeddings', [line('Model', S('embedding').model), line('Provider', S('embedding').provider), line('Dimension', S('embedding').dimension), ...rec('data_embeddings').slice(1)]),
    sec(7, 'VectorDB recommendation', 'vector_db_selection', rec('vector_db_selection')),
    sec(8, 'Index recommendation', 'index_design', rec('index_design')),
    sec(9, 'Model recommendation', 'model_selection', [line('Primary', S('model').primary), line('Secondary', S('model').secondary), line('Fallback', S('model').fallback), ...(d('model_selection')?.why.slice(0, 2) ?? [])]),
    sec(10, 'Inference architecture', 'inference_architecture', [line('Serving', S('inference').servingRuntime), line('Sizing', S('inference').recommended), line('Patterns', S('inference').patterns)]),
    sec(11, 'Infrastructure recommendation', 'infrastructure_design', [line('Deployment', S('infrastructure').deploymentModel), ...Object.entries((S('infrastructure').placements ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`)]),
    sec(12, 'RAG / agent architecture', 'rag_agent_architecture', [line('Scope', S('rag').scope), ...Object.entries(rag ?? {}).map(([k, v]) => `${k}: ${v}`)]),
    sec(13, 'Security architecture', 'security_governance', [line('Overall', S('security').overall), line('Validation', S('security').validation), line('Components', S('security').components), line('Required control gaps', (S('security').requiredControlGaps ?? []).length ? S('security').requiredControlGaps : 'none')]),
    sec(14, 'Performance requirements', 'performance_benchmark', [line('Status', S('performance').status), line('Measured metrics', S('performance').measured), line('Awaiting benchmark', S('performance').requiresBenchmark), line('Failing', (S('performance').failing ?? []).length ? S('performance').failing : 'none')]),
    sec(15, 'Benchmark plan', 'performance_benchmark', d('performance_benchmark')?.benchmarkRequired.slice(0, 8) ?? []),
    sec(16, 'Cost assessment', 'finops', [line('Chosen design', S('cost').chosenMonthlyUsd ? `~$${Math.round(S('cost').chosenMonthlyUsd).toLocaleString()} / month (estimate, not a quote)` : null), line('Budget', S('cost').budget), line('Cheapest allowed option', S('cost').cheapestAllowed), ...(x.tokenObservability ? [tokenLine(s.tokenObservability)] : [])]),
    sec(17, 'Operational model', 'operations_model', [line('Verdict', S('operations').verdict), line('Estimated availability', S('operations').estimatedAvailabilityPercent !== undefined ? `${S('operations').estimatedAvailabilityPercent}%` : null), line('Estimated recovery', S('operations').estimatedRecoveryMinutes !== undefined ? `${S('operations').estimatedRecoveryMinutes} min` : null), line('Operational load', S('operations').operationalLoad)]),
    sec(18, 'Risks', null, [...new Set(decisions.flatMap((r) => r.risks.map((k) => `${r.title}: ${k}`)))].slice(0, 15)),
    sec(19, 'Assumptions', null, [...new Set(decisions.flatMap((r) => r.assumptions.map((a) => `${r.title}: ${a.statement}`)))].slice(0, 15)),
    sec(20, 'Alternatives', null, alternatives.options.length ? alternatives.options.map((o) => `${o.label} (${o.eligibility}) instead of ${o.replaces} - ${o.whenToChoose}`) : [alternatives.note ?? 'No eligible alternatives.']),
    sec(21, 'Final architecture', null, architecture.map((c) => `${c.step}: ${c.component}${c.status === 'stale' ? ' (out of date)' : c.status === 'missing' ? ' (missing)' : ''}`)),
    sec(22, 'Implementation roadmap', null, []),
  ];

  const implementationPlan: FinalResult['implementationPlan'] = {
    build: [
      ...(d('infrastructure_design')?.risks.filter((r) => /Kubernetes|procurement|GPU/i.test(r)).slice(0, 3) ?? []),
      `Ingestion pipeline: ${architecture[3].component} chunking, ${architecture[4].component} embeddings into ${architecture[5].component} (${architecture[6].component}).`,
      `Serving: ${architecture[9].component} with ${architecture[8].component}.`,
      ...(S('rag').scope ? [`Application: ${S('rag').scope}.`] : []),
    ],
    deploy: [str(S('infrastructure').deploymentModel, 'Complete the Infrastructure Design'), ...Object.entries((S('infrastructure').placements ?? {}) as Record<string, string>).map(([k, v]) => `${k} → ${v}`)],
    benchmark: d('performance_benchmark')?.benchmarkRequired.slice(0, 6) ?? ['Complete the Performance & Benchmark assessment.'],
    secure: d('security_governance') ? [...d('security_governance')!.risks.slice(0, 6), ...d('security_governance')!.benchmarkRequired.slice(0, 2)] : ['Complete the Security & Governance assessment.'],
    operate: d('operations_model') ? [...d('operations_model')!.risks.slice(0, 4), ...d('operations_model')!.benchmarkRequired] : ['Complete the Operations model.'],
    scale: [...(d('operations_model')?.tradeoffs.slice(0, 3) ?? []), ...(d('finops')?.wouldChangeIf.slice(0, 2) ?? [])],
  };
  adr[21].lines = (Object.entries(implementationPlan) as Array<[string, string[]]>).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v[0] ?? '—'}${v.length > 1 ? ` (+${v.length - 1} more)` : ''}`);

  const gaps = [...new Set([...readiness.stages.filter((g) => g.status === 'further_assessment').flatMap((g) => g.reasons), ...decisions.flatMap((r) => r.gaps)])];

  return { rulesVersion: FINAL_RULES_VERSION, readiness, executiveSummary, technical, architecture, alternatives, adr, implementationPlan, gaps };
}

const combine = (a: { status: StageStatus; reasons: string[] }, b: { status: StageStatus; reasons: string[] }) => ({ status: worst(a.status, b.status), reasons: [...a.reasons, ...b.reasons] });

/**
 * Token evidence for the cost stage (Token Observability): the estimate
 * against the budget, whether usage has been measured, live cost against
 * the estimate and open token alerts. No estimate yet is handled by the
 * stage itself (the phase is missing).
 */
export function tokenEvidence(section: StateSection | undefined): { status: StageStatus; reasons: string[] } {
  const s = (section?.summary ?? {}) as Record<string, any>;
  if (s.expectedTokensPerRequest === undefined || s.expectedTokensPerRequest === null) return { status: 'pass', reasons: [] };
  let status: StageStatus = 'pass';
  const reasons: string[] = [];
  const share: number | null = s.estimatedShareOfBudget ?? null;
  const est = s.estimatedCost !== null && s.estimatedCost !== undefined ? `~$${Math.round(s.estimatedCost).toLocaleString()} / month` : 'not priced';
  if (share !== null && share > 1) {
    status = 'fail';
    reasons.push(`Token cost estimate (${est}) is ${Math.round(share * 100)}% of the monthly budget.`);
  } else if (share !== null && share >= 0.8) {
    status = worst(status, 'pass_with_conditions');
    reasons.push(`Token cost estimate (${est}) uses ${Math.round(share * 100)}% of the monthly budget.`);
  } else {
    reasons.push(`Token estimate v${s.estimateVersion ?? '?'}: ~${Number(s.expectedTokensPerRequest).toLocaleString()} tokens / request, ${est}.`);
  }
  if (s.telemetryStatus === 'no_telemetry' || !s.telemetryStatus) {
    status = worst(status, 'pass_with_conditions');
    reasons.push('Token usage is estimated only - validate it with a load test (Simulated) or live telemetry before go-live.');
  }
  if ((s.telemetryStatus === 'receiving' || s.telemetryStatus === 'stale') && s.actualCost !== null && s.actualCost !== undefined && s.estimatedCost) {
    const ratio = s.actualCost / s.estimatedCost;
    if (ratio >= 1.5) {
      status = worst(status, 'pass_with_conditions');
      reasons.push(`Live token cost over the last 30 days ($${Math.round(s.actualCost).toLocaleString()}) is ${ratio.toFixed(1)}× the estimate - re-estimate or find the driver.`);
    }
  }
  if (s.alerts > 0) {
    status = worst(status, 'pass_with_conditions');
    reasons.push(`${s.alerts} open token alert(s)${s.criticalAlerts ? `, ${s.criticalAlerts} critical` : ''} - see Token Observability.`);
  }
  return { status, reasons };
}

/** ADR cost section: what the solution is expected to consume, and what was measured. */
function tokenLine(section: StateSection | undefined): string {
  const s = (section?.summary ?? {}) as Record<string, any>;
  if (s.expectedTokensPerRequest === undefined || s.expectedTokensPerRequest === null) return 'Token consumption: not estimated yet (Token Observability)';
  const monthly = s.expectedMonthlyTokens ? `, ~${Intl.NumberFormat('en', { notation: 'compact' }).format(s.expectedMonthlyTokens)} / month` : '';
  const cost = s.estimatedCost !== null && s.estimatedCost !== undefined ? `, ~$${Math.round(s.estimatedCost).toLocaleString()} / month` : '';
  const measured = s.telemetryStatus === 'receiving' || s.telemetryStatus === 'stale' ? '; live telemetry received' : s.telemetryStatus === 'simulated_only' ? '; measured in load tests' : '; estimate only';
  return `Token consumption: ~${Number(s.expectedTokensPerRequest).toLocaleString()} tokens / request${monthly}${cost} (estimate v${s.estimateVersion ?? '?'}${measured})`;
}
