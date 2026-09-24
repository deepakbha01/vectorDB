import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { assessFinops, priceAssignment } from './finops.engine';
import { resolveFinopsContext } from './finops.service';
import { fromFinopsAssessment } from '../decision-record.adapters';
import { FinopsCatalogue, FinopsContext } from './finops.types';
import { InfrastructureCatalogue, TargetId } from '../infrastructure/infrastructure.types';

// The real rate card and target catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/finops.yaml'), 'utf8')) as FinopsCatalogue;
const infraCat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/infrastructure-targets.yaml'), 'utf8')) as InfrastructureCatalogue;
const ALL: TargetId[] = ['on_premises', 'azure', 'aws', 'oci', 'gcp'];
const everywhere = (a: TargetId) => ({ inference: a, vector: a, application: a });
const line = (lines: { item: string }[], start: string) => lines.find((l) => l.item.startsWith(start)) as any;

const ctx = (o: Partial<FinopsContext> = {}): FinopsContext => ({
  allowedTargets: ALL,
  inference: {
    mode: 'self_hosted',
    gpuId: 'h100-80',
    gpuLabel: 'NVIDIA H100 (80 GB)',
    gpusAtPeak: 2,
    gpuMonthlyListUsd: 10_000,
    overheadPercent: 20,
    platformFixedMonthlyUsd: 4000,
    managedMonthlyUsd: 9000,
    managedTierLabel: 'Mid tier',
    requestsPerMonth: 1_000_000,
    tokensPerMonth: 2_000_000_000,
    weightsGb: 70,
    source: 'Inference assessment v1',
  },
  vector: { platform: 'qdrant', kinds: ['kubernetes'], saasTargets: null, cpuCores: 8, memoryGb: 32, storageGb: 100, replicas: 2, replicaReason: '2 replica(s) for 99.9% availability (assumption)', source: 'Vector DB decision (qdrant) sizing estimate' },
  embedding: { model: 'te3', selfHosted: false, pricePer1M: 0.02, corpusTokens: 100_000_000, monthlyNewTokens: 5_000_000, monthlyQueryTokens: 30_000_000, reembedTokens: 300_000_000, source: 'Data Pipeline Design v1' },
  application: { nodes: 2, vcpusPerNode: 4 },
  modelVersionsKept: 2,
  selfHostedEmbeddingGpuListHourly: 0.8,
  requestsPerMonth: 1_000_000,
  dr: { tier: 'warm', reason: 'RTO 30 min (Discovery)' },
  placements: { inference: 'aws', vector_database: 'aws', application: 'aws' },
  deploymentKind: 'single_target',
  gpuAvailability: Object.fromEntries(ALL.map((t) => [t, infraCat.targets[t].gpus])) as Record<TargetId, string[]>,
  monthlyBudgetUsd: 40_000,
  budgetSource: 'Discovery v1',
  missing: [],
  ...o,
});

describe('rate card (config/finops.yaml)', () => {
  it('prices every target on the same basis, and labels itself as directional', () => {
    expect(Object.keys(cat.targets).sort()).toEqual([...ALL].sort());
    for (const t of ALL) expect(Object.keys(cat.targets[t]).sort()).toEqual(['blockStorageGbMonth', 'egressGb', 'gpuFactor', 'monitoringPercent', 'objectStorageGbMonth', 'ramGbHour', 'supportPercent', 'vcpuHour']);
    expect(cat.vectorReplicas.map((r) => r.minAvailability)).toEqual([...cat.vectorReplicas.map((r) => r.minAvailability)].sort((a, b) => b - a));
    expect(cat.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('priceAssignment', () => {
  it('prices self-hosted GPUs from the list price × the target factor, with overhead that scales with it', () => {
    const aws = priceAssignment(everywhere('aws'), ctx(), cat).lines;
    const onPrem = priceAssignment(everywhere('on_premises'), ctx(), cat).lines;
    expect(line(aws, 'GPUs').monthlyUsd).toBe(10_000);
    expect(line(onPrem, 'GPUs').monthlyUsd).toBe(5000);
    expect(line(aws, 'Serving overhead').monthlyUsd).toBe(2000);
    expect(line(onPrem, 'Serving overhead').monthlyUsd).toBe(1000);
    expect(line(aws, 'Platform engineering').monthlyUsd).toBe(4000);
    // Weights are covered by the serving overhead, never priced twice.
    expect(aws.some((l) => l.item.startsWith('Model weights'))).toBe(false);
  });

  it('refuses a target that does not offer the sized GPU', () => {
    const r = priceAssignment(everywhere('oci'), ctx({ inference: { ...ctx().inference!, gpuId: 'l4', gpuLabel: 'NVIDIA L4' } }), cat);
    expect(infraCat.targets.oci.gpus).not.toContain('l4');
    expect(r.notFeasible).toEqual(['NVIDIA L4 is not offered on OCI - re-size for a GPU it offers.']);
  });

  it('prices vector compute and storage per replica, and adds operations for a self-managed database', () => {
    const lines = priceAssignment(everywhere('gcp'), ctx(), cat).lines;
    const g = cat.targets.gcp;
    expect(line(lines, 'Compute - 8 vCPU').monthlyUsd).toBeCloseTo((8 * g.vcpuHour + 32 * g.ramGbHour) * 730 * 2, 1);
    expect(line(lines, 'Storage - 100 GB').monthlyUsd).toBeCloseTo(100 * 2 * g.blockStorageGbMonth, 2);
    expect(line(lines, 'Self-managed vector database operations').monthlyUsd).toBe(1200);
  });

  it('keeps SaaS vector databases to the clouds the vendor runs in, with a premium and a pointer to the vendor calculator', () => {
    const saas = ctx({ vector: { ...ctx().vector!, platform: 'pinecone', kinds: ['saas'], saasTargets: ['aws', 'azure', 'gcp'] } });
    expect(priceAssignment(everywhere('on_premises'), saas, cat).notFeasible[0]).toMatch(/pinecone is saas only and cannot run on On-premises/);
    expect(priceAssignment(everywhere('oci'), saas, cat).notFeasible).toHaveLength(1);
    const aws = priceAssignment(everywhere('aws'), saas, cat).lines;
    expect(line(aws, 'Storage').basis).toMatch(/× 1.8 saas premium .*vendor calculator/);
    expect(aws.some((l) => l.item === 'Self-managed vector database operations')).toBe(false);
  });

  it('adds interconnect and cross-target traffic only when components are split across targets', () => {
    const single = priceAssignment(everywhere('aws'), ctx(), cat).lines;
    const hybrid = priceAssignment({ inference: 'on_premises', vector: 'aws', application: 'aws' }, ctx(), cat).lines;
    expect(single.some((l) => l.item.startsWith('Hybrid interconnect'))).toBe(false);
    expect(line(hybrid, 'Hybrid interconnect').monthlyUsd).toBe(1500);
    expect(line(hybrid, 'Cross-target traffic')).toBeDefined();
  });

  it('bases monitoring on non-inference infrastructure and DR on the tier', () => {
    const lines = priceAssignment(everywhere('aws'), ctx(), cat).lines;
    const infra = lines.filter((l) => l.resource !== 'api' && l.resource !== 'people' && l.category !== 'operations').reduce((s, l) => s + l.monthlyUsd, 0);
    const nonInference = lines.filter((l) => l.resource !== 'api' && l.resource !== 'people' && l.category !== 'operations' && l.category !== 'inference').reduce((s, l) => s + l.monthlyUsd, 0);
    expect(line(lines, 'Monitoring').monthlyUsd).toBeCloseTo(nonInference * 0.05, 1);
    expect(line(lines, 'Disaster recovery - warm').monthlyUsd).toBeCloseTo(infra * 0.5, 0);
    // Cold DR is restore-from-backup: no standby capacity, the backup is the DR copy.
    const cold = priceAssignment(everywhere('aws'), ctx({ dr: { tier: 'cold', reason: 'x' } }), cat).lines;
    expect(line(cold, 'Disaster recovery')).toBeUndefined();
    expect(line(cold, 'Backup (also the cold-DR copy)')).toBeDefined();
  });
});

describe('assessFinops', () => {
  it('compares the same stack on every target and prices the chosen design', () => {
    const r = assessFinops(ctx(), cat);
    expect(r.comparison.map((o) => o.id)).toEqual(ALL);
    expect(r.chosen).toMatchObject({ id: 'chosen', label: 'Chosen design (AWS)', feasible: true });
    expect(r.chosen!.monthlyUsd).toBe(r.comparison.find((o) => o.id === 'aws')!.monthlyUsd);
    expect(r.disclaimer).toMatch(/not quotes and not guaranteed pricing/);
    expect(r.chosen!.lines.every((l) => l.evidenceType !== ('measured' as any))).toBe(true);
    expect(Object.values(r.byResource!).reduce((a, b) => a + b, 0)).toBeCloseTo(r.chosen!.monthlyUsd!, 0);
  });

  it('adds the hybrid option when the Infrastructure Design is hybrid, and picks the cheapest allowed target', () => {
    const r = assessFinops(ctx({ placements: { inference: 'on_premises', vector_database: 'aws', application: 'aws' }, deploymentKind: 'hybrid', allowedTargets: ['on_premises', 'aws'] }), cat);
    expect(r.comparison.map((o) => o.id)).toEqual([...ALL, 'hybrid']);
    expect(r.chosen!.label).toBe('Chosen design (hybrid: On-premises + AWS)');
    expect(r.comparison.find((o) => o.id === 'gcp')!.allowed).toBe(false);
    expect(['on_premises', 'aws', 'hybrid']).toContain(r.cheapestAllowed!.id);
  });

  it('checks the budget: within, near and over', () => {
    const total = assessFinops(ctx(), cat).chosen!.monthlyUsd!;
    expect(assessFinops(ctx({ monthlyBudgetUsd: total * 2 }), cat)).toMatchObject({ budget: { status: 'within_budget' }, validation: { status: 'pass_with_conditions' } });
    expect(assessFinops(ctx({ monthlyBudgetUsd: total / 1.05 }), cat).budget.status).toBe('near_budget');
    const over = assessFinops(ctx({ monthlyBudgetUsd: total / 2 }), cat);
    expect(over.budget.status).toBe('exceeds_budget');
    expect(over.validation).toMatchObject({ status: 'fail' });
    expect(over.validation.reasons[0]).toMatch(/100% over/);
    expect(assessFinops(ctx({ monthlyBudgetUsd: null }), cat).validation.status).toBe('further_assessment');
  });

  it('derives unit economics and one-off embedding costs', () => {
    const r = assessFinops(ctx(), cat);
    const perRequest = r.unitEconomics.find((u) => u.label === 'Inference cost / request')!;
    expect(perRequest.usd).toBeCloseTo(r.chosen!.byCategory!.inference / 1_000_000, 6);
    expect(r.unitEconomics.find((u) => u.label === 'Inference cost / 1M tokens')!.usd).toBeCloseTo((r.chosen!.byCategory!.inference / 2e9) * 1e6, 3);
    expect(r.oneOff.map((o) => o.usd)).toEqual([2, 6]); // 100M and 300M tokens at $0.02 / 1M
  });

  it('prices only whole-stack options when there is no Infrastructure Design', () => {
    const r = assessFinops(ctx({ placements: null, deploymentKind: null }), cat);
    expect(r.chosen).toBeNull();
    expect(r.gaps).toContain('No Infrastructure Design yet - only whole-stack target comparisons are priced.');
    expect(r.validation.status).toBe('further_assessment');
  });

  it('becomes a decision record with cheaper allowed options as alternatives', () => {
    const r = assessFinops(ctx(), cat);
    const rec = fromFinopsAssessment({ id: 'f', version: 1, createdAt: new Date(), result: r } as any);
    expect(rec).toMatchObject({ phase: 'finops', status: 'conditional', confidence: 'medium' });
    expect(rec.alternatives.length).toBeLessThanOrEqual(2);
    expect(rec.alternatives.every((a) => a.eligibility !== 'not_eligible')).toBe(true);
    expect(rec.why).toContain(r.disclaimer);
  });
});

describe('resolveFinopsContext', () => {
  const catalogues = { finops: cat, infrastructure: infraCat, inferencePricing: { selfHostedOverheadPercent: 20, platformFixedMonthlyUsd: 4000 }, gpuListHourly: (id: string) => (id === 'l4' ? 0.8 : null), managedServingIds: ['managed-api'], charsPerToken: 4 };
  const inputs = (o: Record<string, any> = {}): any => ({
    project: { platform: 'undetermined' },
    profile: { inputs: { deploymentTargets: { value: ['on_premises'] } } },
    discovery: { version: 2, qps: 10, availabilityTargetPercent: 99.95, rtoMinutes: 240, requiresMultiRegion: false, regionalFailoverRequired: false, documentCount: 1000, chunksPerDocument: 10, documentGrowthPercentPerMonth: 10, monthlyBudgetUsd: 20000 },
    pipeline: { version: 1, chunkingStrategy: 'fixed_size', chunkSize: 2000, embeddingModelId: 'bge', embeddingProviderId: 'open_source', costPerMillionTokens: 0 },
    adr: { decision: 'postgres_pgvector', infrastructureEstimate: { estimatedCpuCores: 4, estimatedMemoryGb: 16, estimatedStorageGb: 50 } },
    inference: { version: 3, inputsUsed: { autoscaling: true, monthlyBudgetUsd: 5000 }, result: { decision: 'self_hosted', demand: { requestsPerMonth: 100_000, tokensPerMonth: 50_000_000 }, managedApi: { monthlyUsd: 700, tierLabel: 'Mid' }, recommendedGpuOption: { gpuId: 'h200-141', gpuLabel: 'H200', totalGpusAtPeak: 3, monthlyGpuCostPeakUsd: 17_520, monthlyGpuCostAutoscaledUsd: 12_000, footprint: { weightsGb: 70.6 } } } },
    architecture: null,
    infrastructure: { result: { deploymentModel: { kind: 'single_target' }, placements: [{ component: 'inference', chosen: { target: 'on_premises' } }, { component: 'vector_database', chosen: { target: 'on_premises' } }, { component: 'application', chosen: { target: 'on_premises' } }] } },
    ...o,
  });

  it('resolves quantities, never prices, from the upstream records', () => {
    const c = resolveFinopsContext(inputs(), catalogues);
    expect(c.inference).toMatchObject({ mode: 'self_hosted', gpuMonthlyListUsd: 12_000, gpusAtPeak: 3 });
    expect(c.vector).toMatchObject({ kinds: ['vm', 'managed'], replicas: 3, replicaReason: '3 replica(s) for 99.95% availability (assumption)' });
    expect(c.embedding).toMatchObject({ selfHosted: true, corpusTokens: 5_000_000, monthlyNewTokens: 500_000, monthlyQueryTokens: 3_000_000 });
    expect(c.dr).toEqual({ tier: 'cold', reason: 'RTO 240 min allows restore from backup (Discovery)' });
    expect(c).toMatchObject({ allowedTargets: ['on_premises'], placements: { inference: 'on_premises' }, monthlyBudgetUsd: 20000, budgetSource: 'Discovery v2', missing: [] });
  });

  it('prices managed serving when the Inference Architecture chose it, and multi-region as active DR', () => {
    const c = resolveFinopsContext(inputs({ architecture: { version: 4, result: { recommended: { id: 'managed-api' } } }, discovery: { ...inputs().discovery, requiresMultiRegion: true } }), catalogues);
    expect(c.inference!.mode).toBe('managed_api');
    expect(c.inference!.source).toMatch(/managed serving per Inference Architecture v4/);
    expect(c.dr.tier).toBe('active');
  });

  it('refuses to price with nothing to price', () => {
    expect(() => resolveFinopsContext(inputs({ inference: null, adr: null }), catalogues)).toThrow(BadRequestException);
  });
});
