import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { buildRoutes, checkServingEligibility, designInferenceArchitecture, estimateLatency } from './inference-architecture.engine';
import { resolveServingContext } from './inference-architecture.service';
import { fromInferenceArchitecture } from '../decision-record.adapters';
import { ServingCatalogue, ServingContext } from './inference-architecture.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/serving.yaml'), 'utf8')) as ServingCatalogue;
const option = (id: string) => cat.servingOptions.find((o) => o.id === id)!;

const ctx = (o: Partial<ServingContext> = {}): ServingContext => ({
  inferenceVersion: 2,
  inferenceDecision: 'self_hosted',
  allowedFamilies: ['open_weight'],
  modelLabel: 'Llama 3.3 70B Instruct',
  modelParamsB: 70.6,
  apiTierLabel: 'Mid-size general model tier',
  precision: 'fp8',
  tensorParallel: 2,
  gpuLabel: 'NVIDIA H100 SXM (80 GB)',
  totalGpusAtPeak: 4,
  replicas: { min: 2, average: 2, peak: 2 },
  ttftMs: 320,
  tpotMs: 31,
  e2eMs: 9600,
  ttftTargetMs: 2000,
  tpotTargetMs: 50,
  availabilityTargetPercent: 99.9,
  peakRps: 3.5,
  monthlyCostUsd: 28000,
  patterns: ['synchronous', 'streaming'],
  deploymentTargets: ['on_premises', 'azure'],
  hasKubernetes: true,
  hasGpu: true,
  opsCapability: 'dedicated_team',
  needsMultiLora: false,
  restrictedData: false,
  containsPii: false,
  dataResidency: null,
  multiTenant: false,
  securityControls: [],
  routing: null,
  ...o,
});

describe('serving catalogue (config/serving.yaml)', () => {
  it('is complete, technology-neutral and internally consistent', () => {
    const ids = cat.servingOptions.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of cat.servingOptions) {
      for (const t of [o.opsComplexity, o.performanceTier, o.maturityTier, o.costTier]) expect(t >= 1 && t <= 5).toBe(true);
      expect(o.patterns.length).toBeGreaterThan(0);
    }
    expect(Object.values(cat.scoringWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    // Spec §8 options are all represented: vLLM, Triton, Hugging Face, Kubernetes-based, cloud model service, managed endpoint, custom runtime, CPU.
    expect(ids).toEqual(expect.arrayContaining(['vllm-k8s', 'triton-trtllm-k8s', 'tgi-k8s', 'managed-api', 'managed-endpoint', 'custom-runtime', 'cpu-runtime']));
  });
});

describe('checkServingEligibility - mandatory rules make an option NOT ELIGIBLE', () => {
  it.each([
    ['wrong model family', 'managed-api', {}, /managed API models/],
    ['no allowed deployment target', 'managed-endpoint', { deploymentTargets: ['on_premises'] }, /none of the allowed targets \(on-premises\)/],
    ['missing inference pattern', 'tgi-k8s', { patterns: ['synchronous', 'batch'] }, /batch pattern/],
    ['precision not supported', 'cpu-runtime', {}, /sized precision \(FP8\)/],
    ['tensor parallelism required', 'cpu-runtime', { precision: 'int4' }, /split a model across 2 GPUs/],
    ['model too large for the runtime', 'cpu-runtime', { precision: 'int4', tensorParallel: 1 }, /70.6B-parameter model exceeds the 14B/],
    ['multi-LoRA adapters needed', 'custom-runtime', { needsMultiLora: true }, /multi-LoRA/],
    ['nothing feasible upstream', 'vllm-k8s', { allowedFamilies: [], inferenceDecision: 'none_feasible' }, /no feasible serving option/],
  ])('%s', (_n, id, o, message) => {
    const v = checkServingEligibility(option(id as string), ctx(o as Partial<ServingContext>), cat);
    expect(v.eligibility).toBe('not_eligible');
    expect(v.failures.join(' ')).toMatch(message as RegExp);
  });

  it.each([
    ['no Kubernetes platform', 'vllm-k8s', { hasKubernetes: false }, /Needs a Kubernetes platform, and none exists today/],
    ['Kubernetes not stated', 'vllm-k8s', { hasKubernetes: null }, /availability not stated/],
    ['no GPUs on-premises', 'vllm-vm', { hasGpu: false, deploymentTargets: ['on_premises'] }, /procurement lead time/],
    ['ops complexity above capability', 'triton-trtllm-k8s', { opsCapability: 'part_time' }, /Operational complexity 5\/5 exceeds/],
    ['restricted data on a managed API', 'managed-api', { allowedFamilies: ['proprietary_api'], restrictedData: true, dataResidency: 'EU' }, /BAA \/ DPA/],
  ])('conditional: %s', (_n, id, o, message) => {
    const v = checkServingEligibility(option(id as string), ctx(o as Partial<ServingContext>), cat);
    expect(v.eligibility).toBe('conditional');
    expect(v.conditions.join(' ')).toMatch(message as RegExp);
  });
});

describe('designInferenceArchitecture', () => {
  it('recommends an eligible self-hosted runtime and never offers not-eligible options as alternatives', () => {
    const r = designInferenceArchitecture(ctx(), cat);
    expect(r.recommended!.eligibility).toBe('eligible');
    expect(['vllm-k8s', 'tgi-k8s', 'vllm-vm']).toContain(r.recommended!.id);
    const rec = fromInferenceArchitecture({ id: 'a', version: 1, createdAt: new Date(), sources: {}, result: r } as any);
    expect(rec.alternatives.length).toBeLessThanOrEqual(2);
    expect(rec.alternatives.every((a) => a.eligibility !== 'not_eligible')).toBe(true);
  });

  it('prefers simpler operations when the team is small (Triton becomes conditional)', () => {
    const r = designInferenceArchitecture(ctx({ opsCapability: 'part_time' }), cat);
    expect(r.candidates.find((c) => c.id === 'triton-trtllm-k8s')!.eligibility).toBe('conditional');
    expect(r.recommended!.id).not.toBe('triton-trtllm-k8s');
  });

  it('designs a managed-API architecture when the inference assessment chose a managed API', () => {
    const r = designInferenceArchitecture(ctx({ inferenceDecision: 'managed_api', allowedFamilies: ['proprietary_api'], precision: null, tensorParallel: 1, replicas: null, ttftMs: null, tpotMs: null, e2eMs: null }), cat);
    expect(r.recommended!.id).toBe('managed-api');
    expect(r.architecture!.compute[0]).toMatch(/Provider-managed capacity/);
    expect(r.architecture!.autoscaling[0]).toMatch(/Provider autoscaling/);
    expect(r.architecture!.sla.latency).toEqual([]);
  });

  it('reports low confidence and no architecture when nothing is eligible', () => {
    const r = designInferenceArchitecture(ctx({ allowedFamilies: [], inferenceDecision: 'none_feasible' }), cat);
    expect(r).toMatchObject({ recommended: null, architecture: null, confidence: 'low' });
  });

  it('builds every spec §8 layer and deliverable section', () => {
    const a = designInferenceArchitecture(ctx({ patterns: ['synchronous', 'streaming', 'asynchronous'], containsPii: true, dataResidency: 'EU', multiTenant: true }), cat).architecture!;
    expect(a.layers.map((l) => l.layer)).toEqual(['Application', 'Inference gateway', 'Policy engine', 'Model router', 'Inference runtime', 'GPU']);
    expect(a.inferenceApi.join(' ')).toMatch(/server-sent events.*Asynchronous submit/s);
    expect(a.gateway.join(' ')).toMatch(/Per-tenant quotas/);
    expect(a.policy.join(' ')).toMatch(/PII detection.*Pin every inference call to regions inside "EU"/s);
    expect(a.runtime[0]).toMatch(/at FP8, tensor-parallel across 2 GPUs/);
    expect(a.replicaStrategy[0]).toMatch(/Minimum 2 replica/);
    expect(a.autoscaling[0]).toMatch(/Concurrent streams per replica/);
    for (const k of ['loadBalancing', 'fallback', 'observability', 'security', 'cost'] as const) expect(a[k].length).toBeGreaterThan(0);
  });

  it('scales to zero only for batch / asynchronous-only workloads', () => {
    const batch = designInferenceArchitecture(ctx({ patterns: ['asynchronous', 'batch'] }), cat).architecture!;
    const interactive = designInferenceArchitecture(ctx(), cat).architecture!;
    expect(batch.autoscaling.join(' ')).toMatch(/Scale to zero between batches/);
    expect(interactive.autoscaling.join(' ')).toMatch(/Never below 2 warm replica/);
  });
});

describe('estimateLatency - labelled estimates, never measurements', () => {
  it('applies the configured tail factors and compares P95 with the target', () => {
    const l = estimateLatency(ctx({ ttftMs: 1000, ttftTargetMs: 1500 }), cat);
    expect(l[0]).toEqual({ metric: 'Time to first token', p50: 1000, p95: 1600, p99: 2300, targetMs: 1500, meetsTargetAtP95: false });
    expect(l[1]).toMatchObject({ metric: 'Time per output token', p95: Math.round(31 * 1.6), meetsTargetAtP95: true });
    expect(l[2]).toMatchObject({ metric: 'End-to-end response', targetMs: null, meetsTargetAtP95: null });
  });

  it('surfaces a missed P95 target as a risk in the decision record', () => {
    const r = designInferenceArchitecture(ctx({ ttftMs: 1500, ttftTargetMs: 2000 }), cat);
    const rec = fromInferenceArchitecture({ id: 'a', version: 1, createdAt: new Date(), sources: {}, result: r } as any);
    expect(rec.risks.join(' ')).toMatch(/Estimated P95 time to first token 2400 ms exceeds the 2000 ms target/);
    expect(rec.evidence.every((e) => e.evidenceType !== 'measured')).toBe(true);
  });
});

describe('buildRoutes - model routing criteria (spec §8)', () => {
  const routing = { primary: { label: 'Mid API', family: 'proprietary_api' as const }, secondary: { label: 'Llama 70B', family: 'open_weight' as const }, fallback: { label: 'Llama 8B', family: 'open_weight' as const } };

  it('routes by data classification first, then default / cost / availability', () => {
    const rules = buildRoutes(ctx({ routing, restrictedData: true }));
    expect(rules.map((r) => r.when)).toEqual(['Request carries restricted data (PHI / PCI)', 'Default', 'Short / simple request, or tenant over token budget', 'Primary unhealthy, over capacity, or regional outage']);
    expect(rules[0].routeTo).toBe('Llama 70B → Llama 8B'); // the API primary is never used for restricted data
  });

  it('falls back to single-model routing without a Model Selection', () => {
    expect(buildRoutes(ctx())).toEqual([{ when: 'Every request', routeTo: 'Mid-size general model tier', why: 'Single model - no Model Selection with alternatives yet.' }]);
  });
});

describe('resolveServingContext - derived from the latest deliverables, with sources', () => {
  const inference = (o: Record<string, any> = {}): any => ({
    version: 3,
    inputsUsed: { workloadType: 'agent', ttftTargetMs: 800, tpotTargetMs: 50, availabilityTargetPercent: 99.9, opsCapability: 'dedicated_team', containsPii: false, model: { label: 'Llama 3.3 70B', paramsB: 70.6 }, ...o },
    result: {
      decision: 'self_hosted',
      demand: { peakRps: 3.5 },
      managedApi: { tierLabel: 'Mid tier', monthlyUsd: 30000 },
      recommendedGpuOption: { precision: 'fp8', tensorParallel: 2, gpuLabel: 'H100', totalGpusAtPeak: 4, minReplicas: 2, replicasAtAverage: 2, replicasAtPeak: 2, ttftMs: 320, tpotMs: 31, e2eLatencyMs: 9600, monthlyTotalUsd: 28000 },
    },
  });

  it('derives patterns from the workload and TTFT target, and records every source', () => {
    const { context, sources } = resolveServingContext({}, inference(), null, null, { version: 5, hasExistingKubernetes: false, hasGpu: true, tenancyModel: 'shared_multi_tenant' } as any);
    expect(context.patterns).toEqual(['synchronous', 'streaming', 'asynchronous', 'real_time']);
    expect(sources.patterns.detail).toBe('Inference assessment v3: agent workload, TTFT target 800 ms');
    expect(context).toMatchObject({ hasKubernetes: false, multiTenant: true, allowedFamilies: ['open_weight'], tensorParallel: 2 });
    expect(sources.hasKubernetes).toEqual({ source: 'discovery', detail: 'Discovery v5: existing Kubernetes' });
  });

  it('lets the user override patterns and platform availability', () => {
    const { context, sources } = resolveServingContext({ patterns: ['batch'], hasKubernetes: true }, inference(), null, null, null);
    expect(context.patterns).toEqual(['batch']);
    expect(context.hasKubernetes).toBe(true);
    expect(sources.patterns.source).toBe('user');
  });

  it('batch workloads drop synchronous serving', () => {
    expect(resolveServingContext({}, inference({ workloadType: 'batch', ttftTargetMs: 5000 }), null, null, null).context.patterns).toEqual(['asynchronous', 'batch']);
  });
});
