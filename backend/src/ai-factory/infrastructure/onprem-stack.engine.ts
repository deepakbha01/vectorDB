import { scoreBreakdown } from '../eligibility/score-breakdown';
import { InfraContext, InfrastructureCatalogue, OnPremEstate, OnPremStackResult, OnPremStackSpec, Placement, StackCandidate, StackCriterion, StoragePlanRow, TargetId } from './infrastructure.types';

const round = (n: number) => Math.round(n * 1000) / 1000;
const TIE_EPSILON = 0.001;
const NO_ESTATE: OnPremEstate = { storageVendors: [], hypervisor: null, fineTuning: 'none' };

/** What the on-premises stack has to carry: GPUs, vector data, and the cloud targets it must reach. */
export interface StackDemand {
  appliesTo: OnPremStackResult['appliesTo'];
  gpus: number;
  vectorOnPrem: boolean;
  /** Cloud targets the on-premises storage has to extend to (hybrid placement or cloud DR). */
  cloudReach: TargetId[];
  estate: OnPremEstate;
}

/** Null when on-premises is not an allowed target or the catalogue has no stacks. Pure. */
export function stackDemand(ctx: InfraContext, cat: InfrastructureCatalogue, placements: Placement[]): StackDemand | null {
  if (!cat.onPremStacks || !ctx.allowedTargets.includes('on_premises')) return null;
  const at = (id: string) => placements.find((p) => p.component === id)?.chosen ?? null;
  const appliesTo = placements.some((p) => p.chosen?.target === 'on_premises') ? 'chosen' : 'if_on_premises';
  // Size for the components that are (or, for the what-if, would be) on-premises.
  const onPrem = (id: string) => (appliesTo === 'if_on_premises' ? !!at(id) || !placements.some((p) => p.component === id) : at(id)?.target === 'on_premises');
  const inf = ctx.inference;
  const inferenceAt = at('inference');
  const selfHosted = !!inf && !inf.managed && inferenceAt?.platform !== 'managed';
  const gpus = selfHosted && onPrem('inference') ? (inf?.totalGpusAtPeak ?? 0) : 0;
  const vectorAt = at('vector_database');
  // Vendor SaaS never moves on-premises; a cloud-managed database would run on VMs there.
  const vectorOnPrem = !!ctx.vector && onPrem('vector_database') && vectorAt?.platform !== 'saas';
  const chosenClouds = [...new Set(placements.map((p) => p.chosen?.target).filter((t): t is TargetId => !!t && t !== 'on_premises'))];
  const cloudDr = (ctx.requiresMultiRegion || ctx.regionalFailover) && !ctx.multipleOnPremSites;
  const cloudReach = chosenClouds.length ? chosenClouds : cloudDr ? ctx.allowedTargets.filter((t) => t !== 'on_premises') : [];
  return { appliesTo, gpus, vectorOnPrem, cloudReach, estate: ctx.estate ?? NO_ESTATE };
}

export function stackWeights(estate: OnPremEstate, cat: InfrastructureCatalogue): Record<string, number> {
  const w: Record<string, number> = { ...(cat.stackScoringWeights ?? {}) };
  if (estate.fineTuning === 'full' && w.throughput !== undefined) w.throughput *= cat.trainingThroughputMultiplier ?? 1;
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total]));
}

/** Spec §3 for one stack: mandatory rules → NOT ELIGIBLE, closable gaps → CONDITIONAL, then a weighted score. Pure. */
export function checkStack(id: string, s: OnPremStackSpec, d: StackDemand, ctx: InfraContext, cat: InfrastructureCatalogue): StackCandidate {
  const failures: string[] = [];
  const conditions: string[] = [];
  const notes: string[] = [];
  const passed: string[] = [];
  const { gpus, estate } = d;

  if (s.gpus.max !== null && gpus > s.gpus.max) failures.push(`${gpus} GPUs at peak exceed what ${s.label} is built for (up to ${s.gpus.max}).`);
  else if (gpus > 0) passed.push(`${s.label} scales to the ${gpus} GPUs the inference sizing needs.`);
  if (estate.fineTuning === 'full') {
    if (!s.trainingCapable) failures.push(`Full fine-tuning needs sustained parallel throughput and checkpointing, which ${s.label} is not built for - keep training in the cloud or on a parallel file system.`);
    else passed.push(`${s.label} sustains full fine-tuning (parallel throughput, checkpoints).`);
  }

  const order = cat.opsCapabilityOrder;
  if (order.indexOf(ctx.opsCapability) < order.indexOf(s.opsRequirement)) {
    conditions.push(`Needs at least a ${s.opsRequirement.replace(/_/g, ' ')} capability to run (today: ${ctx.opsCapability.replace(/_/g, ' ')}) - or a vendor / partner managed service.`);
  }
  const rpo = ctx.rpoMinutes;
  let meetsRpo = rpo === null ? s.replication.minAsyncRpoMinutes <= 15 : true;
  if (d.vectorOnPrem && rpo !== null) {
    if (rpo === 0 && !s.replication.syncSupported) {
      meetsRpo = false;
      conditions.push(`RPO 0 needs synchronous replication, which ${s.label} does not offer natively - replicate at the vector-database layer.`);
    } else if (rpo > 0 && rpo < s.replication.minAsyncRpoMinutes) {
      meetsRpo = false;
      conditions.push(`RPO ${rpo} min is tighter than native asynchronous replication (${s.replication.minAsyncRpoMinutes} min) - add database-level replication or a backup product.`);
    } else {
      passed.push(`Native replication meets the ${rpo}-minute RPO.`);
    }
  }

  if (gpus < s.gpus.min) notes.push(`Built for ${s.gpus.min}+ GPUs - oversized for ${gpus}; cost and footprint rise without benefit.`);
  if (d.vectorOnPrem && !s.tiers.block) notes.push('No block tier - run the vector database on server-local NVMe and replicate at the database layer.');
  if (estate.hypervisor === 'vmware' && s.hypervisors.includes('nutanix_ahv')) notes.push('VMware estate today - plan the move to AHV (e.g. Nutanix Move) or keep VMware on the same nodes.');
  const reused = s.vendors.filter((v) => estate.storageVendors.includes(v));
  if (reused.length) notes.push(`Reuses the existing ${reused.map((v) => cat.estateStorageVendors?.[v] ?? v).join(', ')} estate (skills, tooling, support contract).`);
  const missingReach = d.cloudReach.filter((t) => !s.cloudExtension.includes(t));
  if (d.cloudReach.length && !missingReach.length) notes.push(`Same storage OS available in ${d.cloudReach.map((t) => cat.targets[t].label).join(', ')} - replicate natively for hybrid / DR.`);

  const stated = estate.storageVendors.length > 0 || estate.hypervisor !== null;
  const reuse = reused.length > 0 || (estate.hypervisor !== null && s.hypervisors.includes(estate.hypervisor));
  const criteria: Record<StackCriterion, number> = {
    scaleFit: s.gpus.max !== null && gpus > s.gpus.max ? 0 : gpus < s.gpus.min ? 0.5 : gpus <= s.gpus.sweetSpotMax ? 1 : 0.6,
    estateReuse: !stated ? 0.5 : reuse ? 1 : 0.2,
    operationalSimplicity: s.ratings.operationalSimplicity / 5,
    dataProtection: meetsRpo ? 1 : 0.4,
    throughput: s.ratings.throughput / 5,
    hybridCloud: d.cloudReach.length ? Math.max(0.2, (d.cloudReach.length - missingReach.length) / d.cloudReach.length) : 1,
  };
  const w = stackWeights(estate, cat);
  const score = round(Object.entries(criteria).reduce((sum, [k, v]) => sum + v * (w[k] ?? 0), 0));
  return {
    id,
    label: s.label,
    eligibility: failures.length ? 'not_eligible' : conditions.length ? 'conditional' : 'eligible',
    failures,
    conditions,
    notes,
    passed,
    score,
    scoreBreakdown: scoreBreakdown(criteria, w),
    bestFor: s.bestFor,
    costRating: s.ratings.cost,
  };
}

const band = (c: StackCandidate) => (c.eligibility === 'eligible' ? 0 : c.eligibility === 'conditional' ? 1 : 2);
const gbText = (n: number) => `${Math.round(n * 10) / 10} GB`;

function storagePlan(s: OnPremStackSpec, d: StackDemand, ctx: InfraContext, cat: InfrastructureCatalogue): StoragePlanRow[] {
  const rows: StoragePlanRow[] = [];
  const reserve = cat.snapshotReserve ?? 0;
  const v = ctx.vector;
  if (d.vectorOnPrem && v) {
    const base = v.forecastStorageGb ?? v.storageGb;
    rows.push({
      tier: s.tiers.block ? 'block' : 'local_nvme',
      purpose: 'Vector database data and indexes',
      product: s.tiers.block ?? 'Server-local NVMe on the database nodes',
      sizeGb: Math.ceil(base * (1 + reserve)),
      basis: `${gbText(base)} ${v.forecastStorageGb !== null ? `at ${v.forecastHorizonMonths} months (Capacity plan)` : 'today'} + ${Math.round(reserve * 100)}% snapshot reserve; low-latency block, not NAS`,
    });
  }
  const weights = ctx.inference?.weightsGb ?? null;
  if (d.gpus > 0 && weights && s.tiers.file) {
    rows.push({
      tier: 'file',
      purpose: 'Model weights and serving artefacts',
      product: s.tiers.file,
      sizeGb: Math.ceil(weights * cat.assumptions.modelVersionsKept),
      basis: `${gbText(weights)} x ${cat.assumptions.modelVersionsKept} versions kept for rollback; shared so every GPU node loads the same copy`,
    });
  }
  if (s.tiers.object) {
    rows.push({
      tier: 'object',
      purpose: 'Source documents, vector-database backups and the model artefact registry',
      product: s.tiers.object,
      sizeGb: d.vectorOnPrem && v ? Math.ceil(v.storageGb * 2) : null,
      basis: d.vectorOnPrem && v ? 'Two backup copies of the vector data; add the source corpus volume' : 'Size from the source corpus volume and retention',
    });
  }
  if (d.estate.fineTuning === 'full') {
    rows.push({
      tier: 'parallel',
      purpose: 'Training data and checkpoints',
      product: s.tiers.parallel ?? s.tiers.file ?? 'Parallel file system',
      sizeGb: null,
      basis: 'Size from the training dataset and checkpoint frequency',
    });
  }
  return rows;
}

/**
 * Wave 13: picks the on-premises compute + storage + platform stack. Runs only
 * when on-premises is allowed: for the chosen design when a component lands
 * on-premises, otherwise as the what-if if the customer insists on on-premises.
 * Pure.
 */
export function recommendOnPremStack(ctx: InfraContext, cat: InfrastructureCatalogue, placements: Placement[]): OnPremStackResult | null {
  const d = stackDemand(ctx, cat, placements);
  if (!d) return null;
  const candidates = Object.entries(cat.onPremStacks!)
    .map(([id, s]) => checkStack(id, s, d, ctx, cat))
    .sort((a, b) => band(a) - band(b) || (Math.abs(b.score - a.score) > TIE_EPSILON ? b.score - a.score : a.id.localeCompare(b.id)));
  const chosen = candidates.find((c) => c.eligibility !== 'not_eligible') ?? null;
  const spec = chosen ? cat.onPremStacks![chosen.id] : null;
  const usable = candidates.filter((c) => c.eligibility !== 'not_eligible').length;
  const why = !chosen
    ? `No on-premises stack fits - ${candidates[0]?.failures[0] ?? 'the catalogue has no stacks'}`
    : `${chosen.label}: highest score (${chosen.score}) among ${usable} usable stack(s) for ${d.gpus ? `${d.gpus} GPUs at peak` : 'a CPU-only footprint'}${d.estate.fineTuning === 'full' ? ' with full fine-tuning' : ''}${chosen.eligibility === 'conditional' ? ` - with conditions: ${chosen.conditions.join(' ').replace(/\.$/, '')}` : ''}.`;
  if (!spec || !chosen) {
    return { appliesTo: d.appliesTo, gpusSized: d.gpus, fineTuning: d.estate.fineTuning, chosen: null, candidates, why, compute: null, platform: null, storagePlan: [], recovery: null, support: null, benchmarkRequired: [] };
  }
  const weights = ctx.inference?.weightsGb ?? null;
  const recovery = {
    modelLoadGbPerMinute: spec.throughput.modelLoadGbPerMinute,
    restoreGbPerMinute: spec.throughput.restoreGbPerMinute,
    modelLoadMinutes: d.gpus > 0 && weights ? Math.ceil(weights / spec.throughput.modelLoadGbPerMinute) : null,
    restoreMinutes: d.vectorOnPrem && ctx.vector ? Math.ceil(ctx.vector.storageGb / spec.throughput.restoreGbPerMinute) : null,
  };
  const twoVendors = /two vendors/i.test(spec.support.contract);
  return {
    appliesTo: d.appliesTo,
    gpusSized: d.gpus,
    fineTuning: d.estate.fineTuning,
    chosen,
    candidates,
    why,
    compute: d.gpus > 0 ? spec.compute : `${spec.compute} - no GPUs needed on-premises for this design`,
    platform: spec.platform,
    storagePlan: storagePlan(spec, d, ctx, cat),
    recovery,
    support: {
      ...spec.support,
      practices: [
        `Register ${spec.support.telemetry} before go-live so the vendor sees health and capacity, and opens cases from telemetry.`,
        ...(twoVendors ? ['Name who triages between the compute and storage vendors (customer, partner or a co-operative support agreement) in the run book.'] : []),
        'Keep firmware, GPU driver, CUDA and NVIDIA AI Enterprise versions on the vendor-validated matrix; patch in that order.',
        'Run the DR drill from storage snapshots / replication and record the achieved RPO / RTO in the Operations model.',
      ],
    },
    benchmarkRequired: [
      `Measure model-load and restore throughput on ${spec.label} (planning figures ${spec.throughput.modelLoadGbPerMinute} / ${spec.throughput.restoreGbPerMinute} GB/min).`,
      ...(d.gpus > 0 ? [`Confirm GPU server lead time and the NVIDIA-validated design for ${d.gpus} GPUs with the vendor.`] : []),
    ],
  };
}
