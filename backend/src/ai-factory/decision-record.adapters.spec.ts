import { fromIndexDesign, fromInferenceAssessment, fromVectorDbSelection, pickAlternatives } from './decision-record.adapters';
import { compareStates } from './ai-factory.service';
import { AssessmentState, StateSection } from './ai-factory.types';

const created = new Date('2026-09-01T10:00:00Z');

function adr(overrides: Record<string, any> = {}): any {
  return {
    id: 'adr-1',
    createdAt: created,
    decision: 'postgres_pgvector',
    rationale: 'Existing PostgreSQL estate and moderate scale.',
    plainLanguageSummary: { headline: 'PostgreSQL + pgvector is a good fit.' },
    decisionStatus: 'single',
    confidence: 'high',
    operationalComplexity: 'low',
    options: [
      { platformId: 'postgres_pgvector', label: 'PostgreSQL + pgvector', totalScore: 0.86, eligibilityStatus: 'eligible', eligibilityNotes: [], evidence: ['fits'] },
      { platformId: 'milvus', label: 'Milvus', totalScore: 0.9, eligibilityStatus: 'ineligible', eligibilityNotes: ['Needs Kubernetes'], evidence: [] },
      { platformId: 'qdrant', label: 'Qdrant', totalScore: 0.8, eligibilityStatus: 'eligible', eligibilityNotes: [], evidence: [] },
      { platformId: 'pinecone', label: 'Pinecone', totalScore: 0.78, eligibilityStatus: 'unverified', eligibilityNotes: ['Residency unverified'], evidence: [] },
      { platformId: 'oracle', label: 'Oracle', totalScore: 0.7, eligibilityStatus: 'eligible', eligibilityNotes: [], evidence: [] },
    ],
    rejectedAlternatives: [
      { platformId: 'milvus', reason: 'Highest raw score but no Kubernetes', bucket: 'strong' },
      { platformId: 'qdrant', reason: 'Close second', bucket: 'strong' },
      { platformId: 'pinecone', reason: 'SaaS', bucket: 'lower_fit' },
      { platformId: 'oracle', reason: 'Lower fit', bucket: 'lower_fit' },
    ],
    assumptions: [
      { parameter: 'qps', value: '20', source: 'Discovery', type: 'customer_provided', validationRequired: false },
      { parameter: 'memory', value: '12 GB', source: 'estimate', type: 'calculated', validationRequired: true },
    ],
    risks: [{ description: 'Growth beyond 5M vectors', impact: 'medium', likelihood: 'low', mitigation: 'Revisit at 5M', validationRequired: true }],
    infrastructureEstimate: { estimatedMemoryGb: 12, estimatedStorageGb: 40, estimatedCpuCores: 4, notes: [] },
    openValidations: ['Confirm pgvector version supports HNSW'],
    budgetFeasibility: { monthlyBudgetUsd: 500, status: 'within_budget', estimatedMonthlyCostUsd: 320, note: '' },
    complianceGate: { applicable: false, status: 'not_applicable', checks: [] },
    ...overrides,
  };
}

describe('pickAlternatives (spec §17)', () => {
  it('never offers a candidate that failed a mandatory requirement, and shows at most two', () => {
    const alts = pickAlternatives(
      [
        { id: 'a', label: 'A', eligibility: 'not_eligible', reason: '' },
        { id: 'rec', label: 'Rec', eligibility: 'eligible', reason: '' },
        { id: 'b', label: 'B', eligibility: 'conditional', reason: '' },
        { id: 'c', label: 'C', eligibility: 'eligible', reason: '' },
        { id: 'd', label: 'D', eligibility: 'eligible', reason: '' },
      ],
      'rec',
    );
    expect(alts.map((a) => a.id)).toEqual(['b', 'c']);
  });
});

describe('fromVectorDbSelection', () => {
  it('keeps eligibility separate from score: an ineligible top scorer is a candidate, never an alternative', () => {
    const r = fromVectorDbSelection(adr(), 3);
    expect(r.recommendation).toEqual({ id: 'postgres_pgvector', label: 'PostgreSQL + pgvector' });
    expect(r.candidates[0]).toMatchObject({ id: 'milvus', score: 0.9, eligibility: 'not_eligible' });
    expect(r.alternatives.map((a) => a.id)).toEqual(['qdrant', 'pinecone']);
    expect(r.alternatives[1].eligibility).toBe('conditional');
    expect(r.source).toEqual({ deliverableId: 'adr-1', version: 3, createdAt: created });
  });

  it('labels evidence, collects validations as benchmark requirements, and explains what would change it', () => {
    const r = fromVectorDbSelection(adr(), 1);
    expect(r.assumptions).toEqual([
      { statement: 'qps = 20 (Discovery)', evidenceType: 'assumption' },
      { statement: 'memory = 12 GB (estimate)', evidenceType: 'estimated' },
    ]);
    expect(r.evidence.every((e) => ['estimated', 'vendor_listed', 'measured', 'assumption'].includes(e.evidenceType))).toBe(true);
    expect(r.benchmarkRequired).toEqual(['Confirm pgvector version supports HNSW', 'Validate: Growth beyond 5M vectors', 'Confirm memory (12 GB)']);
    expect(r.wouldChangeIf[0]).toBe('Milvus would be chosen if: Highest raw score but no Kubernetes');
    expect(r.status).toBe('decided');
    expect(r.gaps).toEqual([]);
  });

  it('maps tied/conditional status, budget overruns and unverified compliance', () => {
    const r = fromVectorDbSelection(adr({ decisionStatus: 'tied', budgetFeasibility: { monthlyBudgetUsd: 100, status: 'exceeds_budget', estimatedMonthlyCostUsd: 320, note: '' }, complianceGate: { applicable: true, status: 'unverified', checks: [] } }), 1);
    expect(r.status).toBe('tied');
    expect(r.wouldChangeIf).toEqual(expect.arrayContaining(['The monthly budget of $100 is fixed - the estimate exceeds it.', 'Required compliance controls cannot be verified on the chosen platform.']));
  });

  it('flags a gap if the recommendation itself is not eligible', () => {
    const r = fromVectorDbSelection(adr({ decision: 'milvus' }), 1);
    expect(r.gaps[0]).toMatch(/not eligible/);
  });
});

describe('fromIndexDesign', () => {
  const design: any = {
    id: 'idx-1', version: 2, createdAt: created, decision: 'hnsw', label: 'HNSW', rationale: 'High recall target.',
    options: [
      { indexType: 'ivf_flat', label: 'IVF-Flat', totalScore: 0.7, evidence: [] },
      { indexType: 'hnsw', label: 'HNSW', totalScore: 0.9, evidence: ['recall'] },
      { indexType: 'pq', label: 'PQ', totalScore: 0.5, evidence: [] },
    ],
    alternatives: [{ indexType: 'ivf_flat', reason: 'Less memory' }, { indexType: 'pq', reason: 'Least memory' }],
    configuration: [{ name: 'M', value: 16, description: '' }],
    impact: { recallEstimate: '~0.95', latencyEstimate: '<20 ms', memoryEstimateGb: 8 },
    scalingConsiderations: ['Memory grows with M'],
    updateFrequency: 'low',
    inputsUsed: { vectorCount: 1000000 },
  };

  it('shows estimates and asks for a benchmark when none has run', () => {
    const r = fromIndexDesign(design, null);
    expect(r.candidates.map((c) => c.id)).toEqual(['hnsw', 'ivf_flat', 'pq']);
    expect(r.evidence.find((e) => e.label === 'Recall')).toEqual({ label: 'Recall', value: '~0.95', evidenceType: 'estimated' });
    expect(r.benchmarkRequired[0]).toMatch(/Run the Optimization benchmark/);
    expect(r.confidence).toBe('not_assessed');
    expect(r.gaps.length).toBe(1);
  });

  it('uses measured benchmark results for the same index type', () => {
    const opt: any = { version: 1, indexType: 'hnsw', sampleSize: 20000, recommendedVariant: { avgRecall: 0.962, p95LatencyMs: 12.4 } };
    const r = fromIndexDesign(design, opt);
    expect(r.evidence.find((e) => e.label === 'Recall@K (benchmark)')).toEqual({ label: 'Recall@K (benchmark)', value: '0.962', evidenceType: 'measured' });
    expect(fromIndexDesign(design, { ...opt, indexType: 'pq' }).evidence.some((e) => e.evidenceType === 'measured')).toBe(false);
  });
});

describe('fromInferenceAssessment', () => {
  const option = (gpuId: string, ok: boolean, cost: number) => ({
    gpuId, gpuLabel: gpuId.toUpperCase(), precision: 'fp8', totalGpusAtPeak: 2, meetsTtft: ok, meetsTpot: ok, monthlyTotalUsd: cost, ttftMs: 300, tpotMs: 30, gpuHourlyUsd: 6.9, notes: [],
  });
  const assessment = (decision: string, excluded = false): any => ({
    id: 'inf-1', version: 4, createdAt: created,
    result: {
      decision,
      decisionRationale: ['Cheaper'],
      recommendedGpuOption: option('h100', true, 20000),
      gpuOptions: [option('h100', true, 20000), option('l4', false, 90000), option('a100', true, 30000)],
      managedApi: { tierLabel: 'Mid tier', monthlyUsd: 32000, inputPer1M: 3, outputPer1M: 15, excluded, exclusionReason: excluded ? 'Policy' : undefined },
      breakEven: { note: 'Self-hosting cheaper above 60k/day' },
      demand: { peakRps: 3.47 },
      risks: ['Licence'],
      assumptions: ['Directional prices'],
    },
  });

  it('treats latency SLO failures as not eligible and never offers them as alternatives', () => {
    const r = fromInferenceAssessment(assessment('self_hosted'));
    expect(r.recommendation?.id).toBe('h100:fp8');
    expect(r.candidates.find((c) => c.id === 'l4:fp8')?.eligibility).toBe('not_eligible');
    expect(r.alternatives.map((a) => a.id)).toEqual(['managed_api', 'a100:fp8']);
    expect(r.confidence).toBe('medium');
  });

  it('labels GPU and API prices as vendor-listed and serving figures as estimates', () => {
    const r = fromInferenceAssessment(assessment('self_hosted'));
    expect(r.evidence.find((e) => e.label === 'GPU list price')?.evidenceType).toBe('vendor_listed');
    expect(r.evidence.find((e) => e.label === 'Time to first token')?.evidenceType).toBe('estimated');
  });

  it('maps managed-API, excluded-API and infeasible outcomes', () => {
    expect(fromInferenceAssessment(assessment('managed_api')).recommendation?.id).toBe('managed_api');
    const excluded = fromInferenceAssessment(assessment('self_hosted', true));
    expect(excluded.alternatives.map((a) => a.id)).toEqual(['a100:fp8']);
    const none = fromInferenceAssessment({ ...assessment('none_feasible'), result: { ...assessment('none_feasible').result, recommendedGpuOption: null } });
    expect(none).toMatchObject({ status: 'not_feasible', recommendation: null, confidence: 'low' });
  });
});

describe('compareStates', () => {
  const s = (status: StateSection['status'], summary: Record<string, unknown>, version = 1): StateSection => ({ status, coverage: 'partial', source: { phase: 'discovery', version, createdAt: created }, summary });
  it('reports which sections and fields changed between two snapshots', () => {
    const a = { scale: s('current', { qps: 20, recallTarget: 0.9 }), cost: s('current', { x: 1 }) } as unknown as AssessmentState;
    const b = { scale: s('stale', { qps: 200, recallTarget: 0.9 }, 2), cost: s('current', { x: 1 }) } as unknown as AssessmentState;
    const r = compareStates(1, a, 2, b);
    expect(r.sections).toEqual([
      { section: 'scale', change: 'changed', statusFrom: 'current', statusTo: 'stale', changedFields: ['source version', 'qps'] },
      { section: 'cost', change: 'unchanged', statusFrom: 'current', statusTo: 'current', changedFields: [] },
    ]);
  });
});
