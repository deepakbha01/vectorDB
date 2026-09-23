import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { assessPerformance, evaluateMetric, shortfallPercent } from './performance.engine';
import { resolvePerformanceContext } from './performance.service';
import { METRIC_IDS } from './create-performance-assessment.dto';
import { fromPerformanceAssessment } from '../decision-record.adapters';
import { MetricInputs, PerformanceCatalogue, PerformanceContext } from './performance.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/performance.yaml'), 'utf8')) as PerformanceCatalogue;
const def = (id: string) => cat.groups.flatMap((g) => g.metrics.map((m) => ({ ...m, group: g.id }))).find((m) => m.id === id)!;
const measured = (value: number, caveats: string[] = []) => ({ value, source: 'bench', measuredAt: '2026-09-20', reported: true, caveats });
const inputs = (o: Partial<MetricInputs> = {}): MetricInputs => ({ applicable: true, target: { value: 800, source: 'Inference assessment v1: TTFT target', assumed: false }, estimate: null, measured: null, ...o });
const evalTtft = (o: Partial<MetricInputs>) => evaluateMetric(def('ttft_p95'), 'llm', inputs(o), cat);

describe('performance catalogue (config/performance.yaml)', () => {
  it('covers the spec §11 groups, and the DTO accepts exactly the catalogue metrics', () => {
    expect(cat.groups.map((g) => g.id)).toEqual(['vector', 'embedding', 'llm', 'infrastructure']);
    expect(cat.groups.flatMap((g) => g.metrics.map((m) => m.id))).toEqual([...METRIC_IDS]);
    expect(Object.keys(cat.statusLabels)).toEqual(['pass', 'pass_with_conditions', 'fail', 'requires_benchmark', 'not_applicable']);
  });
});

describe('evaluateMetric - measured evidence only', () => {
  it('never passes on an estimate, even one that meets the target', () => {
    const r = evalTtft({ estimate: { value: 600, evidenceType: 'estimated', source: 'IA' } });
    expect(r.status).toBe('requires_benchmark');
    expect(r.estimateMeetsTarget).toBe(true);
    expect(r.reasons).toEqual(['No benchmark evidence yet - estimates are never reported as measured performance.']);
  });

  it('warns when the estimate already misses the target', () => {
    const r = evalTtft({ estimate: { value: 914, evidenceType: 'estimated', source: 'IA' } });
    expect(r.status).toBe('requires_benchmark');
    expect(r.reasons[1]).toBe('The estimated figure (914 ms) already misses the target (800 ms) - expect a FAIL unless the design changes.');
  });

  it.each([
    [750, 'pass', 'Measured 750 ms against a target of 800 ms.'],
    [860, 'pass_with_conditions', 'Measured 860 ms - 7.5% short of 800 ms, within the 10% margin.'],
    [1000, 'fail', 'Measured 1,000 ms - 25.0% short of 800 ms.'],
  ])('measured %s ms against 800 ms → %s', (v, status, reason) => {
    const r = evalTtft({ measured: measured(v as number) });
    expect(r.status).toBe(status);
    expect(r.reasons[0]).toBe(reason);
  });

  it('respects direction for higher-is-better metrics', () => {
    expect(shortfallPercent(0.9, 0.95, 'higher')).toBeCloseTo(5.263, 2);
    expect(evaluateMetric(def('recall'), 'vector', inputs({ target: { value: 0.95, source: 'Discovery', assumed: false }, measured: measured(0.97) }), cat).status).toBe('pass');
  });

  it('adds conditions for missing or assumed targets and for caveated measurements', () => {
    expect(evalTtft({ target: null, measured: measured(500) }).conditions).toEqual(['No target set - agree one with the business before production.']);
    const assumed = evalTtft({ target: { value: 800, source: 'assumption: x', assumed: true }, measured: measured(500) });
    expect(assumed.status).toBe('pass_with_conditions');
    expect(assumed.conditions[0]).toMatch(/Target is an assumption/);
    const small = evalTtft({ measured: measured(500, ['Benchmark ran on 10 vectors.']) });
    expect(small.status).toBe('pass_with_conditions');
    expect(small.conditions).toContain('Benchmark ran on 10 vectors.');
    const failing = evalTtft({ measured: measured(2000, ['Measured before X.']) });
    expect(failing.status).toBe('fail');
    expect(failing.reasons).toContain('Measured before X.');
  });

  it('marks metrics outside the architecture as not applicable', () => {
    expect(evalTtft({ applicable: false, notApplicableReason: 'Managed API - no GPUs to operate.' })).toMatchObject({ status: 'not_applicable', reasons: ['Managed API - no GPUs to operate.'] });
  });
});

describe('assessPerformance', () => {
  const ctx = (m: Record<string, Partial<MetricInputs>>): PerformanceContext => ({
    metrics: Object.fromEntries(METRIC_IDS.map((id) => [id, { applicable: false, target: null, estimate: null, measured: null, ...(m[id] ? { applicable: true, ...m[id] } : {}) }])),
    missingInputs: [],
  });

  it('ranks FAIL over REQUIRES BENCHMARK over PASS WITH CONDITIONS over PASS', () => {
    const t = { value: 100, source: 't', assumed: false };
    expect(assessPerformance(ctx({ qps: { target: t, measured: measured(120) } }), cat).status.status).toBe('pass');
    expect(assessPerformance(ctx({ qps: { target: t, measured: measured(95) } }), cat).status.status).toBe('pass_with_conditions');
    const rb = assessPerformance(ctx({ qps: { target: t, measured: measured(120) }, recall: { target: { value: 0.9, source: 'd', assumed: false }, estimate: { value: 0.8, evidenceType: 'estimated', source: 'e' } } }), cat);
    expect(rb.status).toMatchObject({ status: 'requires_benchmark', label: 'REQUIRES BENCHMARK' });
    expect(rb.status.reasons).toEqual(['1 metric(s) have no benchmark evidence yet.', 'Estimates already miss the target for: Recall.']);
    expect(rb.benchmarkPlan).toEqual([{ metric: 'Recall (Vector benchmark)', how: def('recall').how, warning: 'Estimate already misses the target.' }]);
    const f = assessPerformance(ctx({ qps: { target: t, measured: measured(50) }, recall: {} }), cat);
    expect(f.status.status).toBe('fail');
    expect(f.status.reasons[0]).toMatch(/^QPS: Measured 50 queries\/s/);
  });

  it('becomes a decision record whose confidence reflects how much is measured, with evidence labelled by type', () => {
    const r = assessPerformance(ctx({ qps: { target: { value: 100, source: 't', assumed: false }, measured: measured(120) }, ttft_p95: { estimate: { value: 900, evidenceType: 'estimated', source: 'IA' } } }), cat);
    const rec = fromPerformanceAssessment({ id: 'p', version: 1, createdAt: new Date(), result: r } as any);
    expect(rec).toMatchObject({ phase: 'performance_benchmark', status: 'conditional', confidence: 'medium', alternatives: [] });
    expect(rec.evidence.map((e) => [e.label, e.evidenceType])).toEqual([['QPS', 'measured'], ['TTFT P95', 'estimated']]);
    expect(rec.candidates.find((c) => c.id === 'ttft_p95')!.eligibility).toBe('not_assessed');
  });
});

describe('resolvePerformanceContext', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 8, n));
  const base = (o: Record<string, any> = {}): any => ({
    profile: { version: 2, inputs: { targetLatencyMs: { value: 12000 } } },
    discovery: { version: 3, recallTarget: 0.95, peakQps: 50, targetP95LatencyMs: 100, targetP99LatencyMs: 200, estimatedVectorCount: 50_000_000, documentCount: 100_000, chunksPerDocument: 10, availableCpuCores: 16, availableRamGb: 64 },
    pipeline: { version: 1, createdAt: day(1), chunkingStrategy: 'token_based', chunkSize: 400, costPerMillionTokens: 0.02 },
    indexDesign: { version: 1, createdAt: day(2) },
    adr: { createdAt: day(3), infrastructureEstimate: { estimatedCpuCores: 4, estimatedMemoryGb: 16 } },
    optimization: { version: 1, createdAt: day(5), sampleSize: 10_000, queryCount: 500, topK: 10, recommendedVariant: { searchParamName: 'ef', searchParamValue: 128, avgRecall: 0.962, achievedQps: 140.4, p95LatencyMs: 38, p99LatencyMs: 61 } },
    ingestion: { version: 2, createdAt: day(6), status: 'completed', metrics: { documentsSubmitted: 5000, chunksEmbedded: 50_000, durationMs: 100_000 } },
    inference: { version: 4, createdAt: day(4), inputsUsed: { ttftTargetMs: 800, tpotTargetMs: 50 }, result: { decision: 'self_hosted', demand: { peakRps: 6 }, recommendedGpuOption: { gpuId: 'h100-80', ttftMs: 400, tpotMs: 30, e2eLatencyMs: 9400, replicasAtPeak: 2, replicaCapacityRps: 4, batchSize: 16, tensorParallel: 1, footprint: { weightsGb: 40, kvGbPerAvgSequence: 1 } } } },
    selection: { version: 5, requirements: { accuracyRequirement: 'high' } },
    architecture: { version: 6, createdAt: day(7), result: { architecture: { sla: { latency: [{ metric: 'Time to first token', p50: 400, p95: 700, p99: 900 }, { metric: 'Time per output token', p50: 30, p95: 40, p99: 50 }, { metric: 'End-to-end response', p50: 9000, p95: 10000, p99: 12000 }] } } } },
    infrastructure: { version: 7, createdAt: day(8), result: { deploymentModel: { kind: 'hybrid' } } },
    ragAgent: null,
    ...o,
  });
  const resolve = (x: any, dto: any = {}) => resolvePerformanceContext(dto, x, cat, 4, () => 80);

  it('uses the vector benchmark as measured evidence, with its sample-size caveat', () => {
    const m = resolve(base()).metrics;
    expect(m.recall.measured).toMatchObject({ value: 0.962, reported: false, source: 'Optimization benchmark v1 (ef=128, 500 queries, top-10)' });
    expect(m.recall.measured!.caveats).toEqual(['Benchmark ran on 10,000 vectors against ~50,000,000 expected - confirm at production scale.']);
    expect(m.qps.target).toEqual({ value: 50, source: 'Discovery v3: peak QPS', assumed: false });
    expect(m.search_latency_p99.measured!.value).toBe(61);
  });

  it('flags measurements taken before the design they describe', () => {
    const m = resolve(base({ indexDesign: { version: 2, createdAt: day(9) } })).metrics;
    expect(m.recall.measured!.caveats).toContain('Measured before Index design v2 - re-run to confirm it still holds.');
  });

  it('derives embedding throughput from the ingestion run against an assumed load window', () => {
    const m = resolve(base()).metrics;
    expect(m.embedding_tokens_per_sec.measured!.value).toBe(200_000); // 50,000 chunks × 400 tokens / 100 s
    expect(m.documents_per_sec.measured!.value).toBe(50);
    expect(m.embedding_tokens_per_sec.target).toMatchObject({ assumed: true });
    expect(m.embedding_tokens_per_sec.target!.value).toBeCloseTo(400_000_000 / 86_400, 3);
    expect(m.embedding_cost.estimate).toMatchObject({ value: 8, evidenceType: 'vendor_listed' });
  });

  it('estimates LLM and GPU figures, and lets recorded measurements (with their source) take over', () => {
    const m = resolve(base(), { measurements: [{ metric: 'ttft_p95', value: 650, source: 'vLLM benchmark_serving, 40 concurrent', measuredAt: '2026-09-01' }] }).metrics;
    expect(m.ttft_p95.estimate).toMatchObject({ value: 700, evidenceType: 'estimated' });
    expect(m.ttft_p95.measured).toMatchObject({ value: 650, reported: true, source: 'Recorded by the architect: vLLM benchmark_serving, 40 concurrent' });
    expect(m.ttft_p95.measured!.caveats).toEqual(['Measured before Inference Architecture v6 - re-run to confirm it still holds.']);
    expect(m.output_tokens_per_sec.target!.value).toBe(20);
    expect(m.quality.target).toMatchObject({ value: 0.8, assumed: true });
    expect(m.gpu_utilization.estimate!.value).toBe(75); // 6 req/s over 2 × 4
    expect(m.gpu_memory.estimate!.value).toBe(70); // (40 + 16 × 1) / 80
    expect(m.cpu_utilization.estimate!.value).toBe(25);
    expect(m.network.estimate).toMatchObject({ value: 25, evidenceType: 'assumption' });
  });

  it('compares staleness by calendar day, so a result dated the day of the design is current', () => {
    const later = new Date(Date.UTC(2026, 8, 7, 15, 30));
    const m = resolve(base({ architecture: { ...base().architecture, createdAt: later } }), { measurements: [{ metric: 'ttft_p95', value: 650, source: 'load test', measuredAt: '2026-09-07' }] }).metrics;
    expect(m.ttft_p95.measured!.caveats).toEqual([]);
  });

  it('does not ask for GPU metrics on a managed API, and refuses to assess with no inputs', () => {
    const x = base();
    x.inference.result.decision = 'managed_api';
    expect(resolve(x).metrics.gpu_utilization).toMatchObject({ applicable: false, notApplicableReason: 'Managed API - no GPUs to operate.' });
    expect(() => resolve(base({ discovery: null, inference: null }))).toThrow(BadRequestException);
  });
});
