import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { assessOperations, estimateAvailability, estimateRecovery, operationalLoad, planRpo } from './operations.engine';
import { drTier } from './dr-tier';
import { resolveOperationsContext } from './operations.service';
import { fromOperationsModel } from '../decision-record.adapters';
import { OperationsCatalogue, OperationsContext } from './operations.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/operations.yaml'), 'utf8')) as OperationsCatalogue;

const ctx = (o: Partial<OperationsContext> = {}): OperationsContext => ({
  availabilityTargetPercent: 99.5,
  rpoMinutes: 60,
  rtoMinutes: 240,
  opsCapability: 'dedicated_team',
  onCallCoverage: 'business_hours',
  drTested: false,
  dr: { tier: 'cold', reason: 'RTO 240 min allows restore from backup (Discovery)' },
  deployment: { targets: ['aws'], kind: 'single_target', multipleOnPremSites: false, hasKubernetes: true },
  inference: { managed: false, minReplicas: 2, weightsGb: 40, servingLabel: 'vLLM on Kubernetes', gpuUtilizationTarget: 0.7, ttftTargetMs: 800 },
  vector: { platform: 'qdrant', kinds: ['kubernetes'], storageGb: 100, memoryGb: 32, replicas: 2 },
  models: { primary: 'Llama 3.3 70B', secondary: 'Qwen2.5 72B', fallback: 'Qwen2.5 7B' },
  modelVersionsKept: 2,
  agentActs: false,
  capacity: { version: 1, horizons: [{ months: 12, storageGb: 300, memoryGb: 64, triggers: ['memory above the node size'] }], sharding: 'single shard' },
  statements: {
    autoscaling: [{ source: 'Inference Architecture v1', text: 'Scale on: concurrent streams' }],
    load_balancing: [{ source: 'Inference Architecture v1', text: 'Least-outstanding-requests balancing' }],
    observability: [{ source: 'Inference Architecture v1', text: 'Per-request TTFT, tokens in/out and model version' }],
  },
  missing: [],
  ...o,
});
const area = (r: ReturnType<typeof assessOperations>, id: string) => r.areas.find((a) => a.area === id)!;

describe('operations catalogue (config/operations.yaml)', () => {
  it('keeps availabilities as percentages and capacity rising with team maturity', () => {
    for (const v of [...Object.values(cat.componentAvailability), ...Object.values(cat.siteAvailability)]) expect(v).toBeGreaterThan(90);
    const c = cat.operationalLoad.capacity;
    expect(c.none < c.part_time && c.part_time < c.dedicated_team && c.dedicated_team < c.platform_team).toBe(true);
  });
});

describe('drTier (shared with Cost & FinOps)', () => {
  it.each([
    [{ requiresMultiRegion: true, rtoMinutes: 600 }, 'active'],
    [{ regionalFailoverRequired: true, rtoMinutes: 600 }, 'warm'],
    [{ rtoMinutes: 30 }, 'warm'],
    [{ rtoMinutes: 240 }, 'cold'],
    [null, 'cold'],
  ])('%j → %s', (d, tier) => {
    expect(drTier(d as any, 60).tier).toBe(tier);
  });
});

describe('estimateAvailability - the serial request path', () => {
  it('multiplies every component and site on the path', () => {
    const a = estimateAvailability(ctx(), cat);
    // two replicas of a 99.5% component in parallel: 1 - 0.005² = 99.9975%
    expect(a.components.map((c) => c.percent)).toEqual([99.9975, 99.9975, 99.9975, 99.99]);
    expect(a.estimatedPercent).toBeCloseTo((0.999975 ** 3) * 99.99, 2);
    expect(a.meets).toBe(true);
  });

  it('shows why a single on-premises site cannot reach 99.9%', () => {
    const a = estimateAvailability(ctx({ availabilityTargetPercent: 99.9, deployment: { targets: ['on_premises'], kind: 'single_target', multipleOnPremSites: false, hasKubernetes: true } }), cat);
    expect(a.components.at(-1)).toMatchObject({ component: 'On-premises site', percent: 99.9 });
    expect(a.estimatedPercent).toBeCloseTo(99.89, 2);
    expect(a.meets).toBe(false);
    const two = estimateAvailability(ctx({ availabilityTargetPercent: 99.9, deployment: { targets: ['on_premises'], kind: 'single_target', multipleOnPremSites: true, hasKubernetes: true } }), cat);
    expect(two.meets).toBe(true);
  });

  it('uses a single-replica figure when inference has one replica', () => {
    expect(estimateAvailability(ctx({ inference: { ...ctx().inference!, minReplicas: 1 } }), cat).components[1].percent).toBe(99.5);
  });
});

describe('estimateRecovery and planRpo', () => {
  it('adds up cold recovery: provision, restore, reload weights, validate', () => {
    const r = estimateRecovery(ctx(), cat);
    expect(r.steps.map((s) => s.minutes)).toEqual([30, 50, 10, 15]);
    expect(r).toMatchObject({ estimatedMinutes: 105, meets: true });
    const onPrem = estimateRecovery(ctx({ rtoMinutes: 180, deployment: { ...ctx().deployment!, targets: ['on_premises'] } }), cat);
    expect(onPrem).toMatchObject({ estimatedMinutes: 195, meets: false });
  });

  it('uses the standby failover time for warm and active DR', () => {
    expect(estimateRecovery(ctx({ dr: { tier: 'warm', reason: 'x' } }), cat).estimatedMinutes).toBe(15);
    expect(estimateRecovery(ctx({ dr: { tier: 'active', reason: 'x' } }), cat).estimatedMinutes).toBe(2);
  });

  it('chooses snapshots, continuous or synchronous replication from the RPO', () => {
    expect(planRpo(ctx({ rpoMinutes: 240 }), cat)).toMatchObject({ method: 'Scheduled snapshots at least every 240 min, plus re-ingestion from source as the fallback', conditions: [] });
    expect(planRpo(ctx({ rpoMinutes: 15 }), cat).method).toMatch(/^Continuous replication/);
    expect(planRpo(ctx({ rpoMinutes: 15 }), cat).conditions[0]).toMatch(/snapshots alone cannot meet a 15-minute RPO/);
    expect(planRpo(ctx({ rpoMinutes: 0 }), cat).method).toBe('Synchronous replication across failure domains');
  });
});

describe('operationalLoad - can the team run it?', () => {
  it('counts what the design asks the team to run', () => {
    const l = operationalLoad(ctx({ opsCapability: 'part_time', agentActs: true, dr: { tier: 'warm', reason: 'x' }, deployment: { targets: ['on_premises'], kind: 'single_target', multipleOnPremSites: false, hasKubernetes: false } }), cat);
    expect(l.items.map((i) => i.points)).toEqual([3, 2, 1, 1, 1]);
    expect(l).toMatchObject({ total: 8, capacity: 2, withinCapacity: false });
  });

  it('carries less load with managed serving and a managed database', () => {
    const l = operationalLoad(ctx({ inference: { ...ctx().inference!, managed: true }, vector: { ...ctx().vector!, kinds: ['saas'] } }), cat);
    expect(l.total).toBe(0);
  });
});

describe('assessOperations', () => {
  it('is operable with conditions when SLA, RTO, load and on-call all hold - never an unconditional pass', () => {
    const r = assessOperations(ctx(), cat);
    expect(r.verdict.status).toBe('pass_with_conditions');
    expect(r.verdict.reasons).toContain(r.evidenceNote);
    expect(r.areas).toHaveLength(13);
    expect(area(r, 'autoscaling').status).toBe('from_design');
    expect(area(r, 'model_rollback').status).toBe('defined_here');
  });

  it('fails when the SLA, RTO, team size or on-call cannot hold, with the reason', () => {
    const r = assessOperations(
      ctx({
        availabilityTargetPercent: 99.9,
        rtoMinutes: 60,
        opsCapability: 'part_time',
        deployment: { targets: ['on_premises'], kind: 'single_target', multipleOnPremSites: false, hasKubernetes: false },
      }),
      cat,
    );
    expect(r.verdict.status).toBe('fail');
    expect(r.verdict.reasons.join(' ')).toMatch(/Estimated availability .* below the 99.9% target/);
    expect(r.verdict.reasons.join(' ')).toMatch(/Estimated recovery 195 min exceeds the 60-minute RTO/);
    expect(r.verdict.reasons.join(' ')).toMatch(/needs 24x7 on-call; stated: business hours/);
    expect(r.wouldChangeIf).toEqual(expect.arrayContaining([expect.stringMatching(/second on-premises site/), expect.stringMatching(/warm standby/)]));
  });

  it('asks for further assessment when designs are missing', () => {
    const r = assessOperations(ctx({ models: null, capacity: null, deployment: null, missing: ['Infrastructure Design'] }), cat);
    expect(r.verdict.status).toBe('further_assessment');
    expect(area(r, 'model_versioning').status).toBe('gap');
    expect(area(r, 'capacity_planning').status).toBe('gap');
    expect(r.gaps).toContain('No Infrastructure Design yet.');
  });

  it('explains an incident-management gap by the on-call it needs', () => {
    const r = assessOperations(ctx({ availabilityTargetPercent: 99.9, onCallCoverage: null }), cat);
    expect(r.verdict.status).toBe('further_assessment');
    expect(r.gaps).toContain('Incident management: 99.9% availability needs 24x7 on-call (on-call stated: not stated).');
  });

  it('becomes a decision record whose confidence stays low until DR is rehearsed', () => {
    const r = assessOperations(ctx(), cat);
    const rec = fromOperationsModel({ id: 'o', version: 1, createdAt: new Date(), context: { drTested: false }, result: r } as any);
    expect(rec).toMatchObject({ phase: 'operations_model', status: 'conditional', confidence: 'low', alternatives: [] });
    expect(fromOperationsModel({ id: 'o', version: 1, createdAt: new Date(), context: { drTested: true }, result: r } as any).confidence).toBe('medium');
    expect(rec.evidence.find((e) => e.label.startsWith('Recovery time'))!.value).toBe('105 min vs 240 min RTO');
  });
});

describe('resolveOperationsContext', () => {
  const catalogues = { warmStandbyRtoMinutes: 60, modelVersionsKept: 2, vectorReplicas: [{ minAvailability: 99.95, replicas: 3 }, { minAvailability: 99.9, replicas: 2 }, { minAvailability: 0, replicas: 1 }], managedServingIds: ['managed-api'], gpuTargetUtilization: 0.7 };
  const inputs = (o: Record<string, any> = {}): any => ({
    project: { platform: 'undetermined' },
    discovery: { version: 3, availabilityTargetPercent: 99.9, rpoMinutes: 15, rtoMinutes: 240, operationalCapability: 'dedicated_dba' },
    adr: { decision: 'qdrant', infrastructureEstimate: { estimatedStorageGb: 80, estimatedMemoryGb: 24 } },
    capacity: { version: 1, forecast: [{ horizonMonths: 12, estimatedStorageGb: 200, estimatedMemoryGb: 48, scalingTriggersHit: [] }], shardingRecommendation: { strategy: 'single shard' }, haRecommendation: ['3 replicas'], drRecommendation: ['daily snapshots'], recommendedInfrastructure: ['3 nodes'] },
    inference: { version: 4, inputsUsed: { opsCapability: 'dedicated_team', ttftTargetMs: 900 }, result: { decision: 'self_hosted', recommendedGpuOption: { minReplicas: 2, footprint: { weightsGb: 70.6 } } } },
    selection: { result: { primary: { label: 'Llama' }, secondary: null, fallback: { label: 'Qwen 7B' } } },
    architecture: { version: 5, result: { recommended: { id: 'vllm', label: 'vLLM' }, architecture: { autoscaling: ['a'], loadBalancing: ['b'], replicaStrategy: ['c'], fallback: ['d'], observability: ['e'] } } },
    infrastructure: { version: 6, context: { multipleOnPremSites: true, hasKubernetes: false }, result: { deploymentModel: { kind: 'single_target' }, placements: [{ chosen: { target: 'on_premises' } }], sections: { scaling: ['s'], availability: ['h'], disasterRecovery: ['dr'] } } },
    ragAgent: { context: { toolAccess: 'external_actions' }, result: { scope: { agent: true } } },
    ...o,
  });

  it('gathers facts and upstream statements per area, with sources', () => {
    const { context, sources } = resolveOperationsContext({ onCallCoverage: '24x7' }, inputs(), catalogues);
    expect(context).toMatchObject({ availabilityTargetPercent: 99.9, rpoMinutes: 15, opsCapability: 'dedicated_team', onCallCoverage: '24x7', agentActs: true, dr: { tier: 'cold' } });
    expect(context.inference).toMatchObject({ managed: false, minReplicas: 2, servingLabel: 'vLLM', gpuUtilizationTarget: 0.7 });
    expect(context.vector).toMatchObject({ platform: 'qdrant', replicas: 2 });
    expect(context.deployment).toEqual({ targets: ['on_premises'], kind: 'single_target', multipleOnPremSites: true, hasKubernetes: false });
    expect(context.statements.high_availability!.map((s) => s.source)).toEqual(['Inference Architecture v5', 'Infrastructure Design v6', 'Capacity plan v1']);
    expect(sources.onCallCoverage.source).toBe('user');
  });

  it('refuses to model operations with no inputs', () => {
    expect(() => resolveOperationsContext({}, inputs({ discovery: null, inference: null }), catalogues)).toThrow(BadRequestException);
  });
});
