import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { candidatePairs, checkPlacement, designInfrastructure } from './infrastructure.engine';
import { resolveInfraContext, vectorPlatforms } from './infrastructure.service';
import { fromInfrastructureDesign } from '../decision-record.adapters';
import { ComponentNeed, InfraContext, InfrastructureCatalogue } from './infrastructure.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/infrastructure-targets.yaml'), 'utf8')) as InfrastructureCatalogue;
const inference = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/inference.yaml'), 'utf8')) as any;

const gpuInference: ComponentNeed = { id: 'inference', label: 'Inference serving', platforms: ['kubernetes'], gpuId: 'h200-141', gpuLabel: 'NVIDIA H200 (141 GB)', detail: 'vLLM on Kubernetes' };
const vectorK8s: ComponentNeed = { id: 'vector_database', label: 'Vector database', platforms: ['kubernetes'], gpuId: null, gpuLabel: null, saasId: 'qdrant', detail: 'qdrant' };
const app: ComponentNeed = { id: 'application', label: 'Application / gateway', platforms: ['kubernetes', 'vm'], gpuId: null, gpuLabel: null, detail: '' };

const ctx = (o: Partial<InfraContext> = {}): InfraContext => ({
  allowedTargets: ['on_premises', 'azure', 'aws', 'oci', 'gcp'],
  restrictedData: false,
  dataResidency: null,
  availabilityTargetPercent: 99.5,
  haThreshold: 99.9,
  rpoMinutes: 15,
  rtoMinutes: 30,
  requiresMultiRegion: false,
  regionalFailover: false,
  hasKubernetes: true,
  hasGpu: true,
  multipleOnPremSites: false,
  opsCapability: 'dedicated_team',
  components: [gpuInference, vectorK8s, app],
  vector: { platform: 'qdrant', memoryGb: 24, storageGb: 80, cpuCores: 8, forecastStorageGb: 200, forecastHorizonMonths: 24 },
  inference: { servingOption: 'vLLM on Kubernetes', managed: false, gpuLabel: 'NVIDIA H200 (141 GB)', gpuMemoryGb: 141, totalGpusAtPeak: 3, tensorParallel: 1, replicas: { min: 2, average: 2, peak: 3 }, weightsGb: 70.6, autoscaling: 'Scale on: concurrent streams' },
  securityControls: ['Encryption at rest with customer-managed keys'],
  ...o,
});

describe('deployment target catalogue (config/infrastructure-targets.yaml)', () => {
  it('covers the five spec §9 targets and only lists GPUs the inference catalogue knows', () => {
    expect(Object.keys(cat.targets).sort()).toEqual(['aws', 'azure', 'gcp', 'oci', 'on_premises']);
    const known = new Set(inference.gpus.map((g: any) => g.id));
    for (const t of Object.values(cat.targets)) for (const g of t.gpus) expect(known.has(g)).toBe(true);
    expect(cat.targets.on_premises.platforms.managed).toBeUndefined();
    expect(Object.values(cat.scoringWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe('candidatePairs', () => {
  it('offers managed services only in clouds and vendor SaaS only where the vendor runs', () => {
    const managed = candidatePairs({ ...app, id: 'inference', platforms: ['managed'] }, cat).map((p) => p.target);
    expect(managed).not.toContain('on_premises');
    const saas = candidatePairs({ ...vectorK8s, platforms: ['saas'], saasId: 'pinecone' }, cat).map((p) => p.target).sort();
    expect(saas).toEqual(['aws', 'azure', 'gcp']);
  });
});

describe('checkPlacement - mandatory rules and conditions', () => {
  it('rejects targets that are not allowed and GPUs a target does not offer', () => {
    expect(checkPlacement(gpuInference, 'aws', 'kubernetes', ctx({ allowedTargets: ['azure'] }), cat).failures[0]).toMatch(/not an allowed deployment target/);
    const l4 = { ...gpuInference, gpuId: 'l4', gpuLabel: 'NVIDIA L4' };
    expect(checkPlacement(l4, 'azure', 'kubernetes', ctx(), cat).failures[0]).toMatch(/assumes NVIDIA L4, which Azure does not offer - re-size/);
    expect(checkPlacement(l4, 'on_premises', 'kubernetes', ctx(), cat).eligibility).toBe('eligible');
  });

  it.each([
    ['no on-prem Kubernetes', { hasKubernetes: false }, /No on-premises Kubernetes platform/],
    ['no on-prem GPUs', { hasGpu: false }, /GPU procurement|procurement lead time/],
    ['HA on a single site', { availabilityTargetPercent: 99.95 }, /two independent failure domains/],
    ['regional failover on-prem', { regionalFailover: true }, /second on-premises site or a cloud DR target/],
    ['team too small for Kubernetes', { opsCapability: 'part_time' }, /Kubernetes needs at least a dedicated team/],
  ])('conditional on-premises: %s', (_n, o, message) => {
    const v = checkPlacement(gpuInference, 'on_premises', 'kubernetes', ctx(o as Partial<InfraContext>), cat);
    expect(v.eligibility).toBe('conditional');
    expect(v.conditions.join(' ')).toMatch(message as RegExp);
  });

  it('makes restricted data in a cloud conditional on private networking, CMK and a BAA / DPA', () => {
    const v = checkPlacement(gpuInference, 'azure', 'kubernetes', ctx({ restrictedData: true, dataResidency: 'EU' }), cat);
    expect(v.eligibility).toBe('conditional');
    expect(v.conditions[0]).toMatch(/Private Link.*Key Vault.*BAA \/ DPA/);
    expect(v.notes.join(' ')).toMatch(/regions inside "EU"/);
  });
});

describe('designInfrastructure', () => {
  it('co-locates the vector database and application with inference (single target)', () => {
    const r = designInfrastructure(ctx({ allowedTargets: ['aws', 'gcp'] }), cat);
    const targets = r.placements.map((p) => p.chosen!.target);
    expect(new Set(targets).size).toBe(1);
    expect(r.deploymentModel.kind).toBe('single_target');
    expect(r.placements[1].why).toMatch(/co-located with inference/);
  });

  it('is hybrid when components land on different targets, and adds the interconnect to the network and benchmark plan', () => {
    // Pinecone only runs in clouds; inference must stay on-premises.
    const r = designInfrastructure(
      ctx({ allowedTargets: ['on_premises', 'aws'], components: [{ ...gpuInference, gpuId: 'h200-141' }, { ...vectorK8s, platforms: ['saas'], saasId: 'pinecone' }, app], restrictedData: true }),
      cat,
    );
    expect(r.placements.find((p) => p.component === 'vector_database')!.chosen!.target).toBe('aws');
    expect(r.deploymentModel.kind).toBe('hybrid');
    expect(r.sections.network.join(' ')).toMatch(/Private interconnect \/ VPN between/);
    expect(r.benchmarkRequired.join(' ')).toMatch(/round-trip latency between targets/);
  });

  it('reports not feasible when a component has nowhere to go', () => {
    const r = designInfrastructure(ctx({ allowedTargets: ['on_premises'], components: [{ ...vectorK8s, platforms: ['saas'], saasId: 'pinecone' }, app] }), cat);
    expect(r.deploymentModel.kind).toBe('not_feasible');
    expect(r.confidence).toBe('low');
  });

  it('derives DR from RPO / RTO and regional requirements', () => {
    const warm = designInfrastructure(ctx({ rpoMinutes: 5, rtoMinutes: 30, requiresMultiRegion: true, allowedTargets: ['azure'] }), cat).sections.disasterRecovery.join(' ');
    expect(warm).toMatch(/at least every 5 min/);
    expect(warm).toMatch(/RTO 30 min → warm standby/);
    expect(warm).toMatch(/Secondary region/);
    const cold = designInfrastructure(ctx({ rtoMinutes: 480 }), cat).sections.disasterRecovery.join(' ');
    expect(cold).toMatch(/RTO 480 min → restore from backup/);
  });

  it('sizes from the upstream records and labels every figure', () => {
    const r = designInfrastructure(ctx({ allowedTargets: ['gcp'] }), cat);
    expect(r.sections.compute[0]).toMatch(/3 × NVIDIA H200 \(141 GB\) at peak \(3 replica\(s\) × 1 GPU\) on GCP/);
    expect(r.sections.storage.join(' ')).toMatch(/~80 GB today, ~200 GB at 24 months/);
    expect(r.sections.storage.join(' ')).toMatch(/Model weights: 70.6 GB × 2 versions/);
    expect(r.sizing.every((s) => ['estimated', 'assumption', 'vendor_listed', 'measured'].includes(s.evidenceType))).toBe(true);
  });

  it('becomes a standard decision record with at most two eligible alternatives', () => {
    const r = designInfrastructure(ctx(), cat);
    const rec = fromInfrastructureDesign({ id: 'i', version: 1, createdAt: new Date(), sources: { x: { source: 'default', detail: 'd' } }, result: r } as any);
    expect(rec.phase).toBe('infrastructure_design');
    expect(rec.alternatives.length).toBeLessThanOrEqual(2);
    expect(rec.alternatives.every((a) => a.eligibility !== 'not_eligible')).toBe(true);
    expect(rec.recommendation!.label).toBe(r.deploymentModel.summary);
  });
});

describe('resolveInfraContext', () => {
  const serving = { options: [{ id: 'vllm-k8s', requiresKubernetes: true, requiresGpu: true, managed: false }, { id: 'managed-api', requiresKubernetes: false, requiresGpu: false, managed: true }] };
  const rec = { gpuId: 'h100-80', gpuLabel: 'NVIDIA H100', totalGpusAtPeak: 4, tensorParallel: 2, minReplicas: 2, replicasAtAverage: 2, replicasAtPeak: 2, footprint: { weightsGb: 70.6 } };
  const inputs = (o: Record<string, any> = {}): any => ({
    project: { platform: 'undetermined' },
    profile: { version: 2, inputs: { deploymentTargets: { value: ['on_premises'] }, hasGpu: { value: false }, dataResidencyRequirement: { value: 'EU' } }, result: { dataClassification: { level: 'restricted' }, securityRequirements: { controls: ['CMK'] } } },
    discovery: { version: 3, hasExistingKubernetes: false, hasGpu: true, operationalCapability: 'dedicated_dba', availabilityTargetPercent: 99.9, rpoMinutes: 15, rtoMinutes: 60, requiresMultiRegion: false, regionalFailoverRequired: false },
    inference: { version: 4, inputsUsed: { opsCapability: 'dedicated_team', availabilityTargetPercent: 99.9 }, result: { decision: 'self_hosted', recommendedGpuOption: rec } },
    architecture: { version: 1, result: { recommended: { id: 'vllm-k8s', label: 'vLLM on Kubernetes' }, architecture: { autoscaling: ['Scale on: streams'] } } },
    adr: { decision: 'postgres_pgvector', infrastructureEstimate: { estimatedMemoryGb: 12, estimatedStorageGb: 40, estimatedCpuCores: 4 } },
    capacity: null,
    ...o,
  });

  it('builds components from the inference runtime and the vector platform group, with sources', () => {
    const { context, sources } = resolveInfraContext({}, inputs(), serving, () => 80, 99.9);
    expect(context.components.map((c) => [c.id, c.platforms.join('|'), c.gpuId])).toEqual([
      ['inference', 'kubernetes', 'h100-80'],
      ['vector_database', 'vm|managed', null],
      ['application', 'kubernetes|vm', null],
    ]);
    expect(context).toMatchObject({ allowedTargets: ['on_premises'], restrictedData: true, hasKubernetes: false, hasGpu: false, opsCapability: 'dedicated_team', dataResidency: 'EU' });
    expect(sources.hasGpu).toEqual({ source: 'workload_profile', detail: 'Workload Profile v2: GPU availability' });
    expect(sources.inferencePlatform.detail).toBe('Inference Architecture v1: vLLM on Kubernetes');
  });

  it('uses the project platform when it was manually overridden', () => {
    const { context, sources } = resolveInfraContext({}, inputs({ project: { platform: 'pinecone' } }), serving, () => 80, 99.9);
    expect(context.components[1].platforms).toEqual(['saas']);
    expect(sources.vectorPlatform.detail).toMatch(/manual override/);
  });

  it('refuses to design with nothing to place', () => {
    expect(() => resolveInfraContext({}, inputs({ inference: null, architecture: null, adr: null }), serving, () => 80, 99.9)).toThrow(BadRequestException);
  });

  it('maps every vector platform group to deployment platforms', () => {
    expect(vectorPlatforms('qdrant')).toEqual(['kubernetes']);
    expect(vectorPlatforms('oracle')).toEqual(['vm', 'managed']);
    expect(vectorPlatforms('lancedb')).toEqual(['in_app']);
    expect(vectorPlatforms('mongodb_atlas')).toEqual(['saas']);
  });
});

describe('why each placement got its eligibility and score', () => {
  it('lists the mandatory rules a placement meets, never one it also fails, and explains every score', () => {
    const r = designInfrastructure(ctx(), cat);
    for (const p of r.placements) {
      for (const c of p.candidates) {
        expect(c.passed!.filter((x) => c.failures.includes(x))).toEqual([]);
        // The allowed-target rule always applies, so an eligible placement always says why.
        if (c.eligibility === 'eligible') expect(c.passed!.join(' ')).toMatch(/is an allowed deployment target/);
        const b = c.scoreBreakdown!;
        expect(b.map((x) => x.contribution)).toEqual([...b.map((x) => x.contribution)].sort((m, n) => n - m));
        expect(b.reduce((s, x) => s + x.contribution, 0)).toBeCloseTo(c.score, 2);
      }
    }
  });
});

describe('rack-scale systems on-premises', () => {
  const rackSystem = { label: 'NVIDIA GB300 NVL72', gpusPerRack: 72, racks: 1, cpuLabel: 'NVIDIA Grace', cpusPerRack: 36, rackPowerKw: 142, rackPowerEstimated: false, cooling: 'liquid' as const };
  const gb300: ComponentNeed = { ...gpuInference, gpuId: 'gb300-288', gpuLabel: 'NVIDIA GB300 NVL72 (288 GB per GPU)' };
  const rackCtx = (facility: InfraContext['facility']) =>
    ctx({ allowedTargets: ['on_premises'], components: [gb300, vectorK8s, app], inference: { ...ctx().inference!, gpuLabel: gb300.gpuLabel, totalGpusAtPeak: 8, rackSystem }, facility });

  it('rules on-premises out when the data centre has no liquid cooling', () => {
    const r = checkPlacement(gb300, 'on_premises', 'kubernetes', rackCtx({ liquidCooling: false, maxRackPowerKw: 200 }), cat);
    expect(r.eligibility).toBe('not_eligible');
    expect(r.failures.join(' ')).toMatch(/liquid cooled only/);
  });

  it('asks to confirm cooling and power when they are not stated, and flags a power shortfall', () => {
    const unknown = checkPlacement(gb300, 'on_premises', 'kubernetes', rackCtx({ liquidCooling: null, maxRackPowerKw: null }), cat);
    expect(unknown.conditions).toEqual(expect.arrayContaining([expect.stringMatching(/confirm the data centre has it/), expect.stringMatching(/~142 kW per rack - confirm/)]));
    const short = checkPlacement(gb300, 'on_premises', 'kubernetes', rackCtx({ liquidCooling: true, maxRackPowerKw: 40 }), cat);
    expect(short.conditions.join(' ')).toMatch(/above the 40 kW per rack the data centre delivers/);
    expect(short.passed.join(' ')).toMatch(/liquid cooling NVIDIA GB300 NVL72 needs/);
  });

  it('designs whole racks with their facility needs when the data centre is ready', () => {
    const r = designInfrastructure(rackCtx({ liquidCooling: true, maxRackPowerKw: 150 }), cat);
    expect(r.placements.find((p) => p.component === 'inference')?.chosen?.target).toBe('on_premises');
    expect(r.sections.compute[0]).toMatch(/^Inference rack-scale system: 1 × NVIDIA GB300 NVL72 rack\(s\) - 72 GPUs \+ 36 NVIDIA Grace CPUs per rack; 8 GPUs needed at peak, 64 spare/);
    expect(r.sections.compute[1]).toMatch(/~142 kW per rack .*direct-to-chip liquid cooling/);
    expect(r.sizing[0]).toEqual({ label: 'Racks (on-premises)', value: '1 × NVIDIA GB300 NVL72', evidenceType: 'estimated' });
  });

  it('leaves facility checks out of cloud placements and non-rack GPUs', () => {
    const facilityRule = /liquid|kW per rack/;
    const cloud = checkPlacement(gb300, 'azure', 'kubernetes', { ...rackCtx({ liquidCooling: false, maxRackPowerKw: 10 }), allowedTargets: ['on_premises', 'azure'] }, cat);
    expect([...cloud.failures, ...cloud.conditions].join(' ')).not.toMatch(facilityRule);
    const h200 = checkPlacement(gpuInference, 'on_premises', 'kubernetes', ctx({ facility: { liquidCooling: false, maxRackPowerKw: 10 } }), cat);
    expect([...h200.failures, ...h200.conditions].join(' ')).not.toMatch(facilityRule);
  });

  it('derives the rack count from the catalogue when resolving the context', () => {
    const rec = { gpuId: 'gb300-288', gpuLabel: 'GB300', totalGpusAtPeak: 80, tensorParallel: 1, minReplicas: 2, replicasAtAverage: 40, replicasAtPeak: 80, footprint: { weightsGb: 16 } };
    const sys = { id: 'gb300-nvl72', label: 'NVIDIA GB300 NVL72', gpuId: 'gb300-288', gpusPerRack: 72, cpuLabel: 'NVIDIA Grace', cpusPerRack: 36, rackPowerKw: 142, cooling: 'liquid' as const, cloudUnitGpus: 4 };
    const x: any = { project: { platform: 'qdrant' }, profile: null, discovery: null, architecture: null, adr: null, capacity: null, inference: { version: 1, inputsUsed: { opsCapability: 'dedicated_team', availabilityTargetPercent: 99.5 }, result: { decision: 'self_hosted', recommendedGpuOption: rec } } };
    const { context } = resolveInfraContext({ liquidCooling: true, maxRackPowerKw: 150 }, x, { options: [] }, () => 288, 99.9, (id) => (id === 'gb300-288' ? sys : null));
    expect(context.inference?.rackSystem).toMatchObject({ racks: 2, rackPowerKw: 142 });
    expect(context.facility).toEqual({ liquidCooling: true, maxRackPowerKw: 150 });
  });
});

describe('host CPU for on-premises CPU nodes', () => {
  const onPremOnly = (o: Partial<InfraContext> = {}) => ctx({ allowedTargets: ['on_premises'], ...o });
  const all = (r: ReturnType<typeof checkPlacement>) => [...r.failures, ...r.conditions].join(' ');

  it('lists x86, Grace and Vera, with only Vera in preview', () => {
    expect(Object.keys(cat.hostCpus!).sort()).toEqual(['grace', 'vera', 'x86']);
    expect(cat.hostCpus!.vera).toMatchObject({ arch: 'arm64', availability: 'preview' });
    expect(cat.hostCpus!.x86.arch).toBe('x86_64');
  });

  it('adds no Arm conditions on x86 (the default) and names the host CPU in the design', () => {
    expect(all(checkPlacement(app, 'on_premises', 'kubernetes', onPremOnly(), cat))).not.toMatch(/arm64/);
    const r = designInfrastructure(onPremOnly(), cat);
    expect(r.sections.compute.some((l) => l.startsWith('Host CPU for on-premises CPU nodes') && l.includes('x86-64'))).toBe(true);
  });

  it('on Grace, passes a vector database with arm64 builds and asks for arm64 application images', () => {
    const c = onPremOnly({ hostCpu: 'grace' });
    expect(checkPlacement(vectorK8s, 'on_premises', 'kubernetes', c, cat).passed).toContain('qdrant ships arm64 builds for NVIDIA Grace.');
    expect(all(checkPlacement(app, 'on_premises', 'kubernetes', c, cat))).toMatch(/needs an arm64 build for NVIDIA Grace/);
    const actian = onPremOnly({ hostCpu: 'grace', vector: { ...ctx().vector!, platform: 'actian' } });
    expect(all(checkPlacement({ ...vectorK8s, saasId: 'actian' }, 'on_premises', 'kubernetes', actian, cat))).toMatch(/Confirm actian has a supported arm64 build/);
  });

  it('flags Vera as not yet generally available, and leaves cloud placements and inference alone', () => {
    const c = ctx({ hostCpu: 'vera' });
    expect(all(checkPlacement(app, 'on_premises', 'kubernetes', c, cat))).toMatch(/NVIDIA Vera: In full production/);
    expect(all(checkPlacement(app, 'azure', 'kubernetes', c, cat))).not.toMatch(/arm64|Vera/);
    expect(all(checkPlacement(gpuInference, 'on_premises', 'kubernetes', c, cat))).not.toMatch(/arm64|Vera/);
  });
});
