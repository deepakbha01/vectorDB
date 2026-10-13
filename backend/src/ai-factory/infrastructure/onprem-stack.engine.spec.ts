import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { designInfrastructure } from './infrastructure.engine';
import { checkStack, recommendOnPremStack, stackDemand, stackWeights } from './onprem-stack.engine';
import { ComponentNeed, InfraContext, InfrastructureCatalogue, OnPremEstate, Placement } from './infrastructure.types';
import { ESTATE_HYPERVISORS, ESTATE_STORAGE_VENDORS } from './create-infrastructure-design.dto';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/infrastructure-targets.yaml'), 'utf8')) as InfrastructureCatalogue;

const gpuInference: ComponentNeed = { id: 'inference', label: 'Inference serving', platforms: ['kubernetes'], gpuId: 'h100-80', gpuLabel: 'NVIDIA H100 (80 GB)', detail: 'vLLM on Kubernetes' };
const vectorVm: ComponentNeed = { id: 'vector_database', label: 'Vector database', platforms: ['vm', 'managed'], gpuId: null, gpuLabel: null, saasId: 'pgvector', detail: 'pgvector' };
const app: ComponentNeed = { id: 'application', label: 'Application / gateway', platforms: ['kubernetes', 'vm'], gpuId: null, gpuLabel: null, detail: '' };

const estate = (o: Partial<OnPremEstate> = {}): OnPremEstate => ({ storageVendors: [], hypervisor: null, fineTuning: 'none', ...o });
const ctx = (o: Partial<InfraContext> = {}, gpus = 4): InfraContext => ({
  allowedTargets: ['on_premises'],
  restrictedData: true,
  dataResidency: null,
  availabilityTargetPercent: 99.5,
  haThreshold: 99.9,
  rpoMinutes: 15,
  rtoMinutes: 240,
  requiresMultiRegion: false,
  regionalFailover: false,
  hasKubernetes: true,
  hasGpu: true,
  multipleOnPremSites: false,
  opsCapability: 'dedicated_team',
  components: [gpuInference, vectorVm, app],
  vector: { platform: 'pgvector', memoryGb: 24, storageGb: 100, cpuCores: 8, forecastStorageGb: 200, forecastHorizonMonths: 24 },
  inference: { servingOption: 'vLLM on Kubernetes', managed: false, gpuLabel: 'NVIDIA H100 (80 GB)', gpuMemoryGb: 80, totalGpusAtPeak: gpus, tensorParallel: 2, replicas: { min: 1, average: 1, peak: gpus / 2 }, weightsGb: 141, autoscaling: null },
  securityControls: [],
  estate: estate(),
  ...o,
});
const result = (c: InfraContext) => designInfrastructure(c, cat);
const ids = (c: InfraContext) => result(c).onPremStack!.candidates.map((x) => x.id);

describe('on-premises stack catalogue (config/infrastructure-targets.yaml)', () => {
  it('covers NetApp, Nutanix, Dell / EMC, VAST Data and DDN with complete, consistent entries', () => {
    const stacks = Object.values(cat.onPremStacks!);
    const vendors = new Set(stacks.flatMap((s) => s.vendors));
    for (const v of ['netapp', 'nutanix', 'dell_emc', 'vast_data', 'ddn']) expect(vendors.has(v)).toBe(true);
    for (const s of stacks) {
      expect(cat.opsCapabilityOrder).toContain(s.opsRequirement);
      for (const t of s.cloudExtension) expect(Object.keys(cat.targets)).toContain(t);
      for (const v of s.vendors) expect(ESTATE_STORAGE_VENDORS).toContain(v);
      for (const h of s.hypervisors) expect(ESTATE_HYPERVISORS).toContain(h);
      expect(s.tiers.file ?? s.tiers.block).toBeTruthy();
      expect(s.support.telemetry).toBeTruthy();
    }
    expect(Object.keys(cat.estateStorageVendors!).sort()).toEqual([...ESTATE_STORAGE_VENDORS].sort());
    expect(Object.keys(cat.estateHypervisors!).sort()).toEqual([...ESTATE_HYPERVISORS].sort());
    expect(Object.values(cat.stackScoringWeights!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe('stackDemand', () => {
  it('is null when on-premises is not allowed or the catalogue has no stacks', () => {
    expect(result(ctx({ allowedTargets: ['azure'] })).onPremStack).toBeNull();
    const { onPremStacks, ...bare } = cat;
    void onPremStacks;
    expect(designInfrastructure(ctx(), bare as InfrastructureCatalogue).onPremStack).toBeNull();
  });

  it('sizes GPUs only for self-hosted inference that lands on-premises', () => {
    const r = result(ctx());
    expect(r.onPremStack!.appliesTo).toBe('chosen');
    expect(r.onPremStack!.gpusSized).toBe(4);
    const managed = ctx({ inference: { ...ctx().inference!, managed: true }, components: [vectorVm, app] });
    expect(stackDemand(managed, cat, result(managed).placements)!.gpus).toBe(0);
  });

  it('is a what-if when on-premises is allowed but every component lands in a cloud', () => {
    const c = ctx({ allowedTargets: ['on_premises', 'azure'], restrictedData: false, hasKubernetes: false, hasGpu: false, opsCapability: 'part_time' });
    const r = result(c);
    expect(r.deploymentModel.targets).toEqual(['azure']);
    expect(r.onPremStack!.appliesTo).toBe('if_on_premises');
    expect(r.onPremStack!.gpusSized).toBe(4);
    // A what-if never shapes the chosen design.
    expect(r.sections.storage.join(' ')).not.toMatch(/Vector database data and indexes/);
    expect(r.sizing.map((s) => s.label)).not.toContain('On-premises stack');
  });

  it('asks the stack to reach the clouds the design uses, or every allowed cloud for cloud DR', () => {
    const placements: Placement[] = [];
    const d = stackDemand(ctx({ allowedTargets: ['on_premises', 'azure', 'aws'], regionalFailover: true }), cat, placements)!;
    expect(d.cloudReach).toEqual(['azure', 'aws']);
  });
});

describe('checkStack - eligibility rules', () => {
  const demand = (c: InfraContext) => stackDemand(c, cat, result(c).placements)!;

  it('rules out a stack whose GPU ceiling the sizing exceeds', () => {
    const c = ctx({}, 64);
    const nutanix = checkStack('nutanix_hci', cat.onPremStacks!.nutanix_hci, demand(c), c, cat);
    expect(nutanix.eligibility).toBe('not_eligible');
    expect(nutanix.failures[0]).toMatch(/64 GPUs at peak exceed/);
  });

  it('rules out stacks that cannot train when full fine-tuning is needed, and weights throughput up', () => {
    const c = ctx({ estate: estate({ fineTuning: 'full' }) }, 32);
    expect(checkStack('nutanix_hci', cat.onPremStacks!.nutanix_hci, demand(c), c, cat).failures.join(' ')).toMatch(/Full fine-tuning/);
    expect(stackWeights(estate({ fineTuning: 'full' }), cat).throughput).toBeGreaterThan(stackWeights(estate(), cat).throughput);
  });

  it('makes a stack conditional when the ops team is too small or native replication misses the RPO', () => {
    const c = ctx({ opsCapability: 'part_time', rpoMinutes: 10 }, 64);
    const ddn = checkStack('dell_ddn', cat.onPremStacks!.dell_ddn, demand(c), c, cat);
    expect(ddn.eligibility).toBe('conditional');
    expect(ddn.conditions.join(' ')).toMatch(/platform team/);
    expect(ddn.conditions.join(' ')).toMatch(/RPO 10 min is tighter than native asynchronous replication \(60 min\)/);
    const zero = ctx({ rpoMinutes: 0 }, 64);
    expect(checkStack('dell_vast', cat.onPremStacks!.dell_vast, demand(zero), zero, cat).conditions.join(' ')).toMatch(/RPO 0 needs synchronous replication/);
  });

  it('notes an oversized stack and a stack without block storage for the vector database', () => {
    const c = ctx({}, 4);
    const ddn = checkStack('dell_ddn', cat.onPremStacks!.dell_ddn, demand(c), c, cat);
    expect(ddn.notes.join(' ')).toMatch(/oversized for 4/);
    expect(ddn.notes.join(' ')).toMatch(/No block tier/);
  });
});

describe('recommendOnPremStack - what it picks and why', () => {
  it('a small inference-only footprint with a part-time team lands on Nutanix HCI', () => {
    const r = result(ctx({ opsCapability: 'part_time' }, 4)).onPremStack!;
    expect(r.chosen!.id).toBe('nutanix_hci');
    expect(r.chosen!.eligibility).toBe('eligible');
  });

  it('an existing NetApp estate tips a mid-size design to Dell + NetApp, and Dell / EMC to Dell PowerScale', () => {
    expect(result(ctx({ estate: estate({ storageVendors: ['netapp'] }) }, 16)).onPremStack!.chosen!.id).toBe('dell_netapp');
    expect(result(ctx({ estate: estate({ storageVendors: ['dell_emc'] }) }, 16)).onPremStack!.chosen!.id).toBe('dell_powerscale');
  });

  it('a large training estate lands on a high-throughput stack (VAST Data or DDN), never on HCI', () => {
    const r = result(ctx({ opsCapability: 'platform_team', rpoMinutes: null, estate: estate({ fineTuning: 'full' }) }, 256)).onPremStack!;
    expect(['dell_vast', 'dell_ddn']).toContain(r.chosen!.id);
    expect(r.candidates.find((x) => x.id === 'nutanix_hci')!.eligibility).toBe('not_eligible');
    expect(r.storagePlan.map((s) => s.tier)).toContain('parallel');
  });

  it('ranks eligible before conditional before not eligible, and is deterministic', () => {
    const c = ctx({ opsCapability: 'part_time' }, 64);
    const order = result(c).onPremStack!.candidates.map((x) => x.eligibility);
    const rank = { eligible: 0, conditional: 1, not_eligible: 2, not_assessed: 3 } as const;
    expect([...order].sort((a, b) => rank[a] - rank[b])).toEqual(order);
    expect(ids(c)).toEqual(ids(c));
  });

  it('sizes the storage tiers and the recovery from the chosen stack', () => {
    const r = result(ctx({ estate: estate({ storageVendors: ['netapp'] }) }, 16));
    const s = r.onPremStack!;
    const block = s.storagePlan.find((x) => x.tier === 'block')!;
    expect(block.sizeGb).toBe(260); // 200 GB forecast + 30% snapshot reserve
    expect(s.storagePlan.find((x) => x.tier === 'file')!.sizeGb).toBe(282); // 141 GB x 2 versions
    expect(s.recovery).toEqual({ modelLoadGbPerMinute: 30, restoreGbPerMinute: 10, modelLoadMinutes: 5, restoreMinutes: 10 });
    expect(r.sections.storage.join(' ')).toMatch(/NetApp ONTAP AFF/);
    expect(r.sections.disasterRecovery.join(' ')).toMatch(/model reload ~5 min, vector restore ~10 min/);
    expect(r.sizing).toContainEqual({ label: 'On-premises stack', value: s.chosen!.label, evidenceType: 'vendor_listed' });
    expect(r.benchmarkRequired.join(' ')).toMatch(/Measure model-load and restore throughput/);
  });

  it('gives a support model with telemetry and, for two-vendor stacks, who triages', () => {
    const s = result(ctx({ estate: estate({ storageVendors: ['netapp'] }) }, 16)).onPremStack!;
    expect(s.support!.telemetry).toMatch(/Active IQ/);
    expect(s.support!.practices.join(' ')).toMatch(/triages between the compute and storage vendors/);
    const one = result(ctx({ opsCapability: 'part_time' }, 4)).onPremStack!;
    expect(one.support!.practices.join(' ')).not.toMatch(/triages/);
  });

  it('says why nothing fits when every stack is ruled out', () => {
    const tiny = { ...cat, onPremStacks: { nutanix_hci: cat.onPremStacks!.nutanix_hci } };
    const r = recommendOnPremStack(ctx({}, 64), tiny, designInfrastructure(ctx({}, 64), tiny).placements)!;
    expect(r.chosen).toBeNull();
    expect(r.why).toMatch(/No on-premises stack fits - 64 GPUs/);
  });
});
