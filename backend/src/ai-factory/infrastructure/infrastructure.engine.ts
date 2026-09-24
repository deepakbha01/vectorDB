import { ComponentNeed, InfraContext, InfrastructureCatalogue, InfrastructureResult, Placement, PlacementCandidate, PlatformKind, TargetId } from './infrastructure.types';

const round = (n: number) => Math.round(n * 1000) / 1000;
const gb = (n: number) => `${Math.round(n * 10) / 10} GB`;
const TIE_EPSILON = 0.001;
const PLATFORM_LABEL: Record<PlatformKind, string> = { kubernetes: 'Kubernetes', vm: 'VMs', managed: 'managed service', saas: 'vendor SaaS', in_app: 'embedded in the application' };

/** Candidate (target × platform) pairs a component could use, before eligibility. */
export function candidatePairs(need: ComponentNeed, cat: InfrastructureCatalogue): Array<{ target: TargetId; platform: PlatformKind; label: string }> {
  const pairs: Array<{ target: TargetId; platform: PlatformKind; label: string }> = [];
  for (const [target, spec] of Object.entries(cat.targets) as Array<[TargetId, InfrastructureCatalogue['targets'][TargetId]]>) {
    for (const platform of need.platforms) {
      if (platform === 'saas') {
        if (need.saasId && (cat.saasAvailability[need.saasId] ?? []).includes(target)) pairs.push({ target, platform, label: `${spec.label} - ${PLATFORM_LABEL.saas}` });
      } else if (platform === 'in_app') {
        pairs.push({ target, platform, label: `${spec.label} - ${PLATFORM_LABEL.in_app}` });
      } else if (spec.platforms[platform]) {
        pairs.push({ target, platform, label: `${spec.label} - ${spec.platforms[platform]}` });
      }
    }
  }
  return pairs;
}

/** Spec §3 for one placement: mandatory rules → NOT ELIGIBLE; gaps that can be closed → CONDITIONAL. */
export function checkPlacement(need: ComponentNeed, target: TargetId, platform: PlatformKind, ctx: InfraContext, cat: InfrastructureCatalogue) {
  const spec = cat.targets[target];
  const failures: string[] = [];
  const conditions: string[] = [];
  const notes: string[] = [];
  const onPrem = target === 'on_premises';

  if (!ctx.allowedTargets.includes(target)) failures.push(`${spec.label} is not an allowed deployment target.`);
  if (need.gpuId && platform !== 'managed' && !spec.gpus.includes(need.gpuId)) {
    failures.push(`The inference sizing assumes ${need.gpuLabel ?? need.gpuId}, which ${spec.label} does not offer - re-size the inference assessment for this target's GPUs.`);
  }

  const order = cat.opsCapabilityOrder;
  const needed = cat.platformOpsRequirement[platform] ?? 'none';
  if (order.indexOf(ctx.opsCapability) < order.indexOf(needed)) {
    conditions.push(`${PLATFORM_LABEL[platform][0].toUpperCase()}${PLATFORM_LABEL[platform].slice(1)} needs at least a ${needed.replace(/_/g, ' ')} capability (today: ${ctx.opsCapability.replace(/_/g, ' ')}).`);
  }
  if (onPrem && platform === 'kubernetes') {
    if (ctx.hasKubernetes === false) conditions.push('No on-premises Kubernetes platform exists today - it has to be built and run.');
    else if (ctx.hasKubernetes === null) conditions.push('On-premises Kubernetes availability not stated.');
  }
  if (onPrem && need.gpuId && ctx.hasGpu === false) conditions.push(`No GPUs on-premises today - ${need.gpuLabel ?? 'GPU'} procurement lead time applies.`);
  if (onPrem && ctx.availabilityTargetPercent >= ctx.haThreshold && !ctx.multipleOnPremSites) {
    conditions.push(`Availability ${ctx.availabilityTargetPercent}% needs at least two independent failure domains (sites or data halls) on-premises.`);
  }
  if (onPrem && (ctx.requiresMultiRegion || ctx.regionalFailover)) conditions.push('Multi-region / regional failover needs a second on-premises site or a cloud DR target.');
  if (!onPrem && ctx.restrictedData) conditions.push(`Restricted data: ${spec.privateNetworking}, ${spec.keyManagement} and a signed BAA / DPA are required.`);
  if (!onPrem && ctx.dataResidency) notes.push(`Choose ${spec.label} regions inside "${ctx.dataResidency}".`);
  if (need.gpuId && platform !== 'managed' && !onPrem) notes.push('Confirm regional GPU capacity and quota before committing.');

  return { eligibility: failures.length ? ('not_eligible' as const) : conditions.length ? ('conditional' as const) : ('eligible' as const), failures, conditions, notes };
}

export function placementWeights(ctx: InfraContext, cat: InfrastructureCatalogue): Record<string, number> {
  const w: Record<string, number> = { ...cat.scoringWeights };
  if (ctx.restrictedData) w.dataControl *= cat.restrictedDataControlMultiplier;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total]));
}

function scorePlacement(target: TargetId, anchor: TargetId | null, ctx: InfraContext, cat: InfrastructureCatalogue, w: Record<string, number>): number {
  const s = cat.targets[target];
  const criteria: Record<string, number> = {
    elasticity: s.elasticity / 5,
    operationalSimplicity: s.operationalSimplicity / 5,
    dataControl: s.dataControl / 5,
    availability: s.availabilityZones || (target === 'on_premises' && ctx.multipleOnPremSites) ? 1 : 0.4,
    coLocation: anchor === null || anchor === target ? 1 : 0.5,
  };
  return round(Object.entries(criteria).reduce((sum, [k, v]) => sum + v * (w[k] ?? 0), 0));
}

const band = (c: PlacementCandidate) => (c.eligibility === 'eligible' ? 0 : c.eligibility === 'conditional' ? 1 : 2);

export function placeComponent(need: ComponentNeed, anchor: TargetId | null, ctx: InfraContext, cat: InfrastructureCatalogue): Placement {
  const w = placementWeights(ctx, cat);
  const candidates: PlacementCandidate[] = candidatePairs(need, cat)
    .map((p) => ({ component: need.id, target: p.target, platform: p.platform, label: p.label, ...checkPlacement(need, p.target, p.platform, ctx, cat), score: scorePlacement(p.target, anchor, ctx, cat, w) }))
    .sort((a, b) => band(a) - band(b) || (Math.abs(b.score - a.score) > TIE_EPSILON ? b.score - a.score : `${a.target}/${a.platform}`.localeCompare(`${b.target}/${b.platform}`)));
  const chosen = candidates.find((c) => c.eligibility !== 'not_eligible') ?? null;
  const why = !chosen
    ? `No eligible placement for ${need.label.toLowerCase()} - ${candidates[0]?.failures[0] ?? 'no target offers the required platform'}`
    : `${chosen.label}: highest score (${chosen.score}) among ${candidates.filter((c) => c.eligibility !== 'not_eligible').length} usable placement(s)${anchor && chosen.target === anchor ? ', co-located with inference' : ''}${chosen.eligibility === 'conditional' ? ` - with conditions: ${chosen.conditions.join(' ').replace(/\.$/, '')}` : ''}.`;
  return { component: need.id, componentLabel: need.label, chosen, candidates, why };
}

/**
 * Infrastructure Decision Record (spec §9): place inference first (the
 * hardest constraints - GPUs, runtime platform), then the vector database and
 * application with a co-location preference, then size compute, memory,
 * storage, network, cluster, availability, DR, scaling and security. Pure.
 */
export function designInfrastructure(ctx: InfraContext, cat: InfrastructureCatalogue): InfrastructureResult {
  const byId = (id: string) => ctx.components.find((c) => c.id === id);
  const placements: Placement[] = [];
  const inferenceNeed = byId('inference');
  const inferencePlacement = inferenceNeed ? placeComponent(inferenceNeed, null, ctx, cat) : null;
  if (inferencePlacement) placements.push(inferencePlacement);
  const anchor = inferencePlacement?.chosen?.target ?? null;
  const vectorNeed = byId('vector_database');
  const vectorPlacement = vectorNeed ? placeComponent(vectorNeed, anchor, ctx, cat) : null;
  if (vectorPlacement) placements.push(vectorPlacement);
  const appNeed = byId('application');
  if (appNeed) placements.push(placeComponent(appNeed, anchor ?? vectorPlacement?.chosen?.target ?? null, ctx, cat));

  const chosenTargets = [...new Set(placements.map((p) => p.chosen?.target).filter((t): t is TargetId => !!t))];
  const infeasible = placements.some((p) => !p.chosen);
  const kind: InfrastructureResult['deploymentModel']['kind'] = infeasible ? 'not_feasible' : chosenTargets.length > 1 ? 'hybrid' : 'single_target';
  const summary =
    kind === 'not_feasible'
      ? `Not feasible: ${placements.filter((p) => !p.chosen).map((p) => p.componentLabel.toLowerCase()).join(', ')} cannot be placed on any allowed target.`
      : kind === 'hybrid'
        ? `Hybrid across ${chosenTargets.map((t) => cat.targets[t].label).join(' + ')}: ${placements.map((p) => `${p.componentLabel.toLowerCase()} on ${cat.targets[p.chosen!.target].label}`).join(', ')}.`
        : `Single target: everything on ${cat.targets[chosenTargets[0]]?.label ?? '-'}.`;

  const anyConditional = placements.some((p) => p.chosen?.eligibility === 'conditional');
  const confidence: InfrastructureResult['confidence'] = infeasible ? 'low' : anyConditional ? 'medium' : 'high';

  const sections = buildSections(ctx, cat, placements, chosenTargets);
  const sizing = buildSizing(ctx, cat);

  return {
    rulesVersion: cat.rulesVersion,
    deploymentModel: { kind, targets: chosenTargets, summary },
    placements,
    confidence,
    sections,
    sizing,
    wouldChangeIf: [
      ...placements.flatMap((p) => {
        const alt = p.candidates.find((c) => c.eligibility === 'not_eligible' && p.chosen && c.score > p.chosen.score);
        return alt ? [`${p.componentLabel}: ${alt.label} would score higher but ${alt.failures[0].charAt(0).toLowerCase()}${alt.failures[0].slice(1)}`] : [];
      }),
      'Allowed deployment targets, data classification, availability / DR targets, or the inference GPU sizing change.',
    ],
    benchmarkRequired: [
      ...placements.flatMap((p) => (p.chosen?.conditions ?? []).map((c) => `Validate (${p.componentLabel.toLowerCase()}): ${c}`)),
      ...(kind === 'hybrid' ? ['Measure round-trip latency between targets on the request path (application ↔ vector database ↔ inference) against the latency budget.'] : []),
      'Run a DR drill (restore from backup and fail over) and record the achieved RPO / RTO.',
    ],
  };
}

function buildSections(ctx: InfraContext, cat: InfrastructureCatalogue, placements: Placement[], targets: TargetId[]): InfrastructureResult['sections'] {
  const at = (id: string) => placements.find((p) => p.component === id)?.chosen ?? null;
  const inf = ctx.inference;
  const inferenceAt = at('inference');
  const vectorAt = at('vector_database');
  const a = cat.assumptions;
  const onPremOnly = targets.length > 0 && targets.every((t) => t === 'on_premises');
  const ha = ctx.availabilityTargetPercent >= ctx.haThreshold;

  const compute = [
    ...(inf && inferenceAt
      ? inf.managed || inferenceAt.platform === 'managed'
        ? [`Inference: provider-managed capacity on ${cat.targets[inferenceAt.target].label} - no GPUs to operate`]
        : [`Inference: ${inf.totalGpusAtPeak ?? '?'} × ${inf.gpuLabel ?? 'GPU'} at peak (${inf.replicas ? `${inf.replicas.peak} replica(s) × ${inf.tensorParallel} GPU` : 'replicas per sizing'}) on ${cat.targets[inferenceAt.target].label}`]
      : []),
    ...(ctx.vector && vectorAt ? [`Vector database (${ctx.vector.platform}): ~${Math.ceil(ctx.vector.cpuCores)} vCPU on ${cat.targets[vectorAt.target].label} (${PLATFORM_LABEL[vectorAt.platform]})`] : []),
    `Application / gateway: ${a.applicationNodes} × ${a.applicationVcpusPerNode} vCPU nodes (assumption - size from load test)`,
  ];
  const memory = [
    ...(ctx.vector ? [`Vector database: ~${gb(ctx.vector.memoryGb)} RAM for vectors and index (from the Vector DB decision record)`] : []),
    ...(inf?.gpuMemoryGb && inf.totalGpusAtPeak && !inf.managed ? [`GPU memory: ${gb(inf.gpuMemoryGb)} per GPU × ${inf.totalGpusAtPeak} at peak`] : []),
  ];
  const storage = [
    ...(ctx.vector ? [`Vector database: ~${gb(ctx.vector.storageGb)} today${ctx.vector.forecastStorageGb !== null ? `, ~${gb(ctx.vector.forecastStorageGb)} at ${ctx.vector.forecastHorizonMonths} months (Capacity plan)` : ''}`] : []),
    ...(inf?.weightsGb && !inf.managed ? [`Model weights: ${gb(inf.weightsGb)} × ${a.modelVersionsKept} versions kept for rollback, on fast local or shared storage per GPU node`] : []),
    'Logs and traces: sized by retention policy (see Operations phase)',
  ];
  const network = [
    ...targets.map((t) => `${cat.targets[t].label}: ${cat.targets[t].privateNetworking}`),
    'Single ingress through the inference gateway; no public model or vector-database endpoints',
    ...(targets.length > 1 ? [`Private interconnect / VPN between ${targets.map((t) => cat.targets[t].label).join(' and ')} - it sits on the request path`] : []),
    ...(inf?.managed ? ['Egress to the provider model endpoint over private connectivity where offered'] : []),
  ];
  const cluster = [
    ...(inferenceAt?.platform === 'kubernetes' && inf && !inf.managed
      ? [`GPU node pool: ${inf.gpuLabel ?? 'GPU'} nodes, tainted for inference only, ${inf.replicas?.min ?? 1}-${inf.replicas?.peak ?? 1} replicas`]
      : []),
    ...(vectorAt?.platform === 'kubernetes' ? ['Stateful node pool for the vector database with persistent volumes and anti-affinity'] : []),
    ...(placements.some((p) => p.chosen?.platform === 'kubernetes') ? ['System / CPU node pool for gateway, router, policy engine and observability agents'] : ['VM groups per component behind load balancers']),
  ];
  const availability = [
    `Target ${ctx.availabilityTargetPercent}%${ha ? ' - replicas spread across at least two failure domains' : ''}`,
    ...targets.map((t) => (cat.targets[t].availabilityZones ? `${cat.targets[t].label}: spread across availability zones` : `${cat.targets[t].label}: ${ctx.multipleOnPremSites ? 'spread across the available sites' : 'single site - a site failure takes the service down'}`)),
    ...(inf?.replicas ? [`Inference: minimum ${inf.replicas.min} warm replica(s)`] : []),
  ];
  const rto = ctx.rtoMinutes;
  const disasterRecovery = [
    ctx.rpoMinutes !== null ? `RPO ${ctx.rpoMinutes} min → vector database backups / replication at least every ${ctx.rpoMinutes} min` : 'RPO not stated - set one before go-live',
    rto !== null
      ? rto <= a.warmStandbyRtoMinutes
        ? `RTO ${rto} min → warm standby (pre-provisioned capacity, including GPUs, in the DR location)`
        : `RTO ${rto} min → restore from backup into the DR location (cold standby acceptable)`
      : 'RTO not stated - set one before go-live',
    ...(ctx.requiresMultiRegion || ctx.regionalFailover ? [onPremOnly ? 'Second on-premises site required for regional failover' : 'Secondary region with replicated vector data and deployable inference capacity'] : []),
    'Model weights and configuration are rebuildable from the artefact registry - back up data and indexes, not GPUs',
    ...targets.map((t) => `${cat.targets[t].label} backup: ${cat.targets[t].backup}`),
  ];
  const scaling = [
    ...(inf?.autoscaling ? [`Inference: ${inf.autoscaling}`] : []),
    ...(ctx.vector?.forecastHorizonMonths ? [`Vector database: grow to the ${ctx.vector.forecastHorizonMonths}-month Capacity plan; review triggers there`] : ['Vector database: re-run the Capacity plan to set scaling triggers']),
    ...targets.map((t) => (cat.targets[t].elasticity >= 4 ? `${cat.targets[t].label}: elastic - scale node pools on demand (GPU quota permitting)` : `${cat.targets[t].label}: fixed capacity - buy ahead of the forecast`)),
  ];
  const security = [
    ...targets.map((t) => `${cat.targets[t].label}: ${cat.targets[t].keyManagement}; ${cat.targets[t].privateNetworking}`),
    'Workload identity for service-to-service calls; no long-lived secrets in the cluster',
    ...ctx.securityControls,
  ];
  return { compute, memory, storage, network, cluster, availability, disasterRecovery, scaling, security };
}

function buildSizing(ctx: InfraContext, cat: InfrastructureCatalogue): InfrastructureResult['sizing'] {
  const rows: InfrastructureResult['sizing'] = [];
  if (ctx.inference && !ctx.inference.managed && ctx.inference.totalGpusAtPeak) rows.push({ label: 'GPUs at peak', value: `${ctx.inference.totalGpusAtPeak} × ${ctx.inference.gpuLabel}`, evidenceType: 'estimated' });
  if (ctx.inference?.weightsGb) rows.push({ label: 'Model weights', value: gb(ctx.inference.weightsGb), evidenceType: 'estimated' });
  if (ctx.vector) {
    rows.push({ label: 'Vector DB memory', value: gb(ctx.vector.memoryGb), evidenceType: 'estimated' });
    rows.push({ label: 'Vector DB storage', value: gb(ctx.vector.storageGb), evidenceType: 'estimated' });
    rows.push({ label: 'Vector DB CPU', value: `${Math.ceil(ctx.vector.cpuCores)} vCPU`, evidenceType: 'estimated' });
  }
  rows.push({ label: 'Application nodes', value: `${cat.assumptions.applicationNodes} × ${cat.assumptions.applicationVcpusPerNode} vCPU`, evidenceType: 'assumption' });
  rows.push({ label: 'GPU availability per target', value: 'Directional catalogue - confirm capacity / quota / procurement', evidenceType: 'vendor_listed' });
  return rows;
}
