import { architectureAlternatives, buildFinalRecommendation, explain, readinessGate } from './final.engine';
import { FinalInputs } from './final.types';
import { AssessmentState, DecisionRecord, PhaseKey, PhaseLineage, StateSection } from '../ai-factory.types';

const PHASES: PhaseKey[] = [
  'discovery', 'workload_profile', 'data_embeddings', 'index_design', 'vector_db_selection', 'model_selection', 'inference', 'inference_architecture',
  'infrastructure_design', 'rag_agent_architecture', 'security_governance', 'performance_benchmark', 'finops', 'operations_model', 'final_recommendation',
];
const lineage = (o: Partial<Record<PhaseKey, Partial<PhaseLineage>>> = {}): PhaseLineage[] =>
  PHASES.map((phase) => ({ phase, label: phase.replace(/_/g, ' '), route: phase, status: 'current', latest: phase === 'final_recommendation' ? null : ({ version: 1, createdAt: new Date() } as any), versions: 1, upstream: [], reasons: [], ...o[phase] }) as PhaseLineage);
const sec = (summary: Record<string, unknown>): StateSection => ({ status: 'current', coverage: 'full', source: null, summary }) as StateSection;
const state = (o: Partial<Record<keyof AssessmentState, Record<string, unknown>>> = {}): AssessmentState => {
  const base: Record<keyof AssessmentState, Record<string, unknown>> = {
    useCase: { businessObjective: 'Answer clinicians from guidelines', dataSources: ['guidelines'], profileStatus: 'complete', businessDomain: 'health' },
    scale: { workloadSize: 'large', architecture: 'RAG + agent', expectedVectorCount: 50_000_000, dailyRequests: 400_000, peakQps: 1200, dataClassification: 'restricted' },
    data: { chunkingStrategy: 'recursive', chunkSize: 1200 },
    embedding: { model: 'bge-large', provider: 'open_source', dimension: 1024 },
    vectorDB: { platform: 'postgres_pgvector', projectPlatform: 'undetermined' },
    index: { index: 'hnsw' },
    model: { primary: 'Llama 3.3 70B', secondary: 'Qwen2.5 72B', fallback: 'Qwen2.5 7B' },
    inference: { servingRuntime: 'vLLM on Kubernetes', recommended: '9 × H200' },
    tokenObservability: {},
    infrastructure: { deploymentModel: 'Single target: everything on On-premises.', placements: { 'Inference serving': 'On-premises - Kubernetes' } },
    rag: { scope: 'RAG + agent: hybrid; no reranking', decisions: { Reranking: 'No reranking' } },
    security: { overall: 'Approved with conditions', validation: 'pass_with_conditions' },
    performance: { status: 'PASS', statusKey: 'pass' },
    cost: { chosenMonthlyUsd: 21_885, budget: 'within_budget', validation: 'pass_with_conditions' },
    operations: { verdict: 'pass_with_conditions', estimatedAvailabilityPercent: 99.98, estimatedRecoveryMinutes: 162 },
    recommendation: {},
  };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, sec({ ...v, ...(o as any)[k] })])) as unknown as AssessmentState;
};
const record = (phase: PhaseKey, o: Partial<DecisionRecord> = {}): DecisionRecord => ({
  phase,
  title: phase.replace(/_/g, ' '),
  source: { deliverableId: 'x', version: 1, createdAt: new Date() },
  status: 'decided',
  recommendation: { id: 'chosen', label: `${phase} choice` },
  confidence: 'high',
  why: [`why ${phase}`],
  candidates: [{ id: 'chosen', label: 'chosen', eligibility: 'eligible', score: 0.9, notes: [] }, { id: 'alt', label: `${phase} alt`, eligibility: 'eligible', score: 0.8, notes: ['strong recall'] }],
  alternatives: [{ id: 'alt', label: `${phase} alt`, eligibility: 'eligible', reason: 'score 0.8' }],
  tradeoffs: [],
  risks: [],
  assumptions: [],
  evidence: [],
  benchmarkRequired: [`benchmark ${phase}`],
  wouldChangeIf: [`if ${phase} changes`],
  gaps: [],
  ...o,
});
const TECH: PhaseKey[] = ['data_embeddings', 'index_design', 'vector_db_selection', 'model_selection', 'inference_architecture', 'infrastructure_design', 'rag_agent_architecture'];
const inputs = (o: Partial<FinalInputs> = {}): FinalInputs => ({ projectName: 'Clinical assistant', state: state(), lineage: lineage(), decisions: TECH.map((p) => record(p)), ...o });
const stageOf = (x: FinalInputs, k: string) => readinessGate(x).stages.find((s) => s.stage === k)!;

describe('production readiness gate (spec §25)', () => {
  it('runs the seven stages in the spec order and always gives a reason', () => {
    const g = readinessGate(inputs());
    expect(g.stages.map((s) => s.stage)).toEqual(['data', 'requirements', 'security', 'technology', 'performance', 'cost', 'operations']);
    expect(g.stages.every((s) => s.reasons.length > 0)).toBe(true);
    expect(g).toMatchObject({ status: 'ready_with_conditions', label: 'PRODUCTION READY WITH CONDITIONS' });
    expect(g.reasons.map((r) => r.split(':')[0])).toEqual(['Security validation', 'Cost validation', 'Operational validation']);
  });

  it('is PRODUCTION READY only when every stage passes', () => {
    const all = inputs({ state: state({ security: { validation: 'pass' }, cost: { validation: 'pass' }, operations: { verdict: 'pass' } }) });
    expect(readinessGate(all)).toMatchObject({ status: 'production_ready', reasons: ['Every gate stage passes on current, measured evidence.'] });
  });

  it('is NOT SUITABLE when any stage fails, naming the failing stages', () => {
    const g = readinessGate(inputs({ state: state({ security: { validation: 'fail' } }) }));
    expect(g.status).toBe('not_suitable');
    expect(g.reasons).toEqual(['Security validation: Security & Governance: fail.']);
  });

  it('requires further assessment for missing benchmarks, missing phases and out-of-date results', () => {
    expect(stageOf(inputs({ state: state({ performance: { statusKey: 'requires_benchmark' } }) }), 'performance')).toMatchObject({ status: 'further_assessment', reasons: ['Performance & Benchmark: requires benchmark evidence.'] });
    const missing = stageOf(inputs({ lineage: lineage({ finops: { latest: null, status: 'not_started' } }), state: state({ cost: { validation: undefined } }) }), 'cost');
    expect(missing.status).toBe('further_assessment');
    expect(missing.reasons).toContain('Not done yet: finops.');
    const stale = stageOf(inputs({ lineage: lineage({ security_governance: { status: 'stale' } }) }), 'security');
    expect(stale.status).toBe('further_assessment');
    expect(stale.reasons).toContain('Out of date - re-run: security governance.');
    expect(readinessGate(inputs({ lineage: lineage({ security_governance: { status: 'stale' } }) })).status).toBe('further_assessment');
  });

  it('fails technology eligibility when a chosen technology has no eligible option, and conditions it otherwise', () => {
    const fail = inputs({ decisions: TECH.map((p) => record(p, p === 'vector_db_selection' ? { status: 'not_feasible', recommendation: null } : {})) });
    expect(stageOf(fail, 'technology')).toMatchObject({ status: 'fail', reasons: ['vector db selection: no eligible option.'] });
    const cond = inputs({ decisions: TECH.map((p) => record(p, p === 'model_selection' ? { status: 'conditional' } : {})) });
    expect(stageOf(cond, 'technology').status).toBe('pass_with_conditions');
  });

  it('carries phase gaps into requirement validation', () => {
    const x = inputs({ decisions: TECH.map((p) => record(p, p === 'rag_agent_architecture' ? { gaps: ['No source field for citations.'] } : {})) });
    expect(stageOf(x, 'requirements')).toMatchObject({ status: 'pass_with_conditions', reasons: ['rag agent architecture: 1 open gap(s) - No source field for citations.'] });
    expect(stageOf(inputs({ state: state({ useCase: { profileStatus: 'incomplete' } }) }), 'data').status).toBe('further_assessment');
  });
});

describe('explainability (spec §16 / §24)', () => {
  it('answers what is satisfied, partially satisfied and not satisfied', () => {
    const e = explain(record('model_selection', { status: 'conditional', risks: ['licence review'], gaps: ['no multilingual eval'] }), false);
    expect(e.satisfied).toEqual(['Mandatory requirements for model selection - met with conditions']);
    expect(e.partiallySatisfied).toEqual(['licence review']);
    expect(e.notSatisfied).toEqual(['no multilingual eval']);
    expect(explain(record('index_design', { status: 'not_feasible', recommendation: null, why: ['nothing fits'] }), true)).toMatchObject({ satisfied: [], notSatisfied: ['nothing fits'], outOfDate: true });
  });
});

describe('alternatives (spec §17)', () => {
  it('offers two alternatives in order of architectural impact, never one that fails a mandatory requirement', () => {
    const decisions = TECH.map((p) => record(p, p === 'vector_db_selection' ? { alternatives: [{ id: 'bad', label: 'bad', eligibility: 'not_eligible', reason: 'x' }] } : {}));
    const a = architectureAlternatives(inputs({ decisions }));
    expect(a.options.map((o) => o.sourcePhase)).toEqual(['model_selection', 'inference_architecture']);
    expect(a.options.every((o) => o.eligibility !== 'not_eligible')).toBe(true);
    expect(a.options[0]).toMatchObject({ replaces: 'model selection: model_selection choice', whenToChoose: 'if model_selection changes', strengths: ['Score 0.8 in model selection', 'strong recall'] });
    expect(a.note).toBeNull();
  });

  it('says so when fewer than two eligible alternatives exist', () => {
    const decisions = TECH.map((p) => record(p, { alternatives: p === 'index_design' ? [{ id: 'alt', label: 'ivf', eligibility: 'conditional', reason: 'needs tuning' }] : [] }));
    const a = architectureAlternatives(inputs({ decisions }));
    expect(a.options).toHaveLength(1);
    expect(a.options[0].risks).toEqual(['needs tuning']);
    expect(a.note).toMatch(/Only 1 eligible alternative/);
  });
});

describe('buildFinalRecommendation', () => {
  it('produces the spec §15 architecture chain and the 22-section ADR', () => {
    const r = buildFinalRecommendation(inputs());
    expect(r.architecture.map((c) => c.step)).toEqual(['Use case', 'Data sources', 'Ingestion', 'Chunking', 'Embedding', 'VectorDB', 'Index', 'Reranker', 'LLM / SLM', 'Inference serving', 'AI application', 'Security', 'Monitoring', 'FinOps']);
    expect(r.architecture.find((c) => c.step === 'VectorDB')!.component).toBe('postgres_pgvector');
    expect(r.architecture.find((c) => c.step === 'FinOps')!.component).toBe('~$21,885 / month (estimate)');
    expect(r.adr.map((s) => s.number)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(r.adr[0].title).toBe('Executive summary');
    expect(r.adr[21].title).toBe('Implementation roadmap');
    expect(r.adr[21].lines[0]).toMatch(/^Build: /);
    // Cross-phase sections have no single source, so they are never 'missing'.
    expect(r.adr.filter((s) => s.source === null).every((s) => s.status === 'current')).toBe(true);
    expect(r.executiveSummary.estimatedScale).toBe('large - 50,000,000 vectors, 400,000 requests / day, peak 1,200 QPS');
  });

  it('marks missing and out-of-date parts instead of inventing them', () => {
    const r = buildFinalRecommendation(inputs({ lineage: lineage({ index_design: { latest: null, status: 'not_started' }, finops: { status: 'stale' } }) }));
    expect(r.adr.find((s) => s.title === 'Index recommendation')).toMatchObject({ status: 'missing', lines: ['Not assessed yet - complete index design.'] });
    expect(r.architecture.find((c) => c.step === 'FinOps')!.status).toBe('stale');
  });

  it('keeps the executive summary honest about confidence', () => {
    expect(buildFinalRecommendation(inputs()).executiveSummary).toMatchObject({ primaryModel: 'Llama 3.3 70B', vectorDb: 'postgres_pgvector', confidence: 'medium' });
    const low = inputs({ decisions: TECH.map((p) => record(p, p === 'infrastructure_design' ? { confidence: 'low' } : {})) });
    expect(buildFinalRecommendation(low).executiveSummary.confidence).toBe('low');
    const failing = inputs({ state: state({ cost: { validation: 'fail' } }) });
    const r = buildFinalRecommendation(failing);
    expect(r.executiveSummary.confidence).toBe('low');
    expect(r.executiveSummary.keyRisks[0]).toBe('Cost validation: Cost & FinOps: fail.');
  });

  it('builds the implementation plan from the phases that own each step', () => {
    const decisions = [...TECH.map((p) => record(p)), record('performance_benchmark', { benchmarkRequired: ['TTFT P95 load test'] }), record('security_governance', { risks: ['Embedding model: sign a DPA'] })];
    const p = buildFinalRecommendation(inputs({ decisions })).implementationPlan;
    expect(Object.keys(p)).toEqual(['build', 'deploy', 'benchmark', 'secure', 'operate', 'scale']);
    expect(p.benchmark).toEqual(['TTFT P95 load test']);
    expect(p.secure[0]).toBe('Embedding model: sign a DPA');
    expect(p.operate).toEqual(['Complete the Operations model.']);
  });
});

describe('token evidence in the cost stage (Token Observability, phase 8)', () => {
  const passing = { security: { validation: 'pass' }, cost: { validation: 'pass' }, operations: { verdict: 'pass' } };
  const tokenPhase = { phase: 'token_observability', label: 'Token observability', route: 'token-observability', status: 'current', latest: { version: 2, createdAt: new Date() }, versions: 2, upstream: [], reasons: [] } as unknown as PhaseLineage;
  const token = (o: Record<string, unknown> = {}) => ({ expectedTokensPerRequest: 7050, expectedMonthlyTokens: 7_050_000_000, estimatedCost: 12_000, estimateVersion: 2, estimatedShareOfBudget: 0.5, telemetryStatus: 'simulated_only', actualCost: null, alerts: 0, criticalAlerts: 0, ...o });
  const on = (t: Record<string, unknown> | null, withPhase = true) =>
    inputs({ tokenObservability: true, lineage: withPhase ? [...lineage(), tokenPhase] : lineage(), state: state({ ...passing, ...(t ? { tokenObservability: t } : {}) }) });

  it('changes nothing while Token Observability is off', () => {
    const off = inputs({ state: state({ ...passing, tokenObservability: token({ estimatedShareOfBudget: 5 }) }) });
    expect(stageOf(off, 'cost')).toMatchObject({ status: 'pass', phases: ['finops'], reasons: ['Cost & FinOps: pass.'] });
    expect(readinessGate(off).status).toBe('production_ready');
    expect(buildFinalRecommendation(off).adr.find((a) => a.number === 16)!.lines.join(' ')).not.toMatch(/Token consumption/);
  });

  it('passes on an estimate within budget that was measured in load tests', () => {
    const c = stageOf(on(token()), 'cost');
    expect(c).toMatchObject({ status: 'pass', phases: ['finops', 'token_observability'] });
    expect(c.reasons).toEqual(['Cost & FinOps: pass.', 'Token estimate v2: ~7,050 tokens / request, ~$12,000 / month.']);
  });

  it('asks for the estimate when it has not been made', () => {
    const c = stageOf(on(null, false), 'cost');
    expect(c.status).toBe('further_assessment');
    expect(c.reasons.join(' ')).toMatch(/Not done yet: token_observability/);
  });

  it('conditions an estimate that was never measured', () => {
    const c = stageOf(on(token({ telemetryStatus: 'no_telemetry' })), 'cost');
    expect(c.status).toBe('pass_with_conditions');
    expect(c.reasons).toContain('Token usage is estimated only - validate it with a load test (Simulated) or live telemetry before go-live.');
  });

  it('fails when the token estimate alone exceeds the budget, and conditions it from 80%', () => {
    expect(stageOf(on(token({ estimatedShareOfBudget: 1.3 })), 'cost').status).toBe('fail');
    expect(readinessGate(on(token({ estimatedShareOfBudget: 1.3 }))).status).toBe('not_suitable');
    expect(stageOf(on(token({ estimatedShareOfBudget: 0.85 })), 'cost').reasons.join(' ')).toMatch(/uses 85% of the monthly budget/);
  });

  it('conditions live cost well above the estimate and open token alerts', () => {
    const c = stageOf(on(token({ telemetryStatus: 'receiving', actualCost: 24_000, alerts: 3, criticalAlerts: 1 })), 'cost');
    expect(c.status).toBe('pass_with_conditions');
    expect(c.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/Live token cost .*2\.0× the estimate/), '3 open token alert(s), 1 critical - see Token Observability.']));
  });

  it('records token consumption in the ADR cost section', () => {
    const adr = buildFinalRecommendation(on(token({ telemetryStatus: 'receiving' }))).adr.find((a) => a.number === 16)!;
    expect(adr.lines).toContain('Token consumption: ~7,050 tokens / request, ~7.1B / month, ~$12,000 / month (estimate v2; live telemetry received)');
  });
});
