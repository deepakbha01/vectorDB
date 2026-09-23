import { AreaResult, AvailabilityEstimate, OperationsArea, OperationsCatalogue, OperationsContext, OperationsResult, RecoveryEstimate, RpoPlan, Statement } from './operations.types';

export const AREA_LABELS: Record<OperationsArea, string> = {
  autoscaling: 'Autoscaling',
  load_balancing: 'Load balancing',
  high_availability: 'High availability',
  disaster_recovery: 'Disaster recovery',
  backup: 'Backup',
  failover: 'Failover',
  model_versioning: 'Model versioning',
  model_rollback: 'Model rollback',
  observability: 'Observability',
  alerting: 'Alerting',
  capacity_planning: 'Capacity planning',
  upgrade_strategy: 'Upgrade strategy',
  incident_management: 'Incident management',
};
export const EVIDENCE_NOTE = 'Availability and recovery times are estimates from planning assumptions (config/operations.yaml) - confirm them with a DR rehearsal and measured availability.';
const THIS = 'Operations model';
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Serial availability of the request path: every component and every site it depends on. Pure. */
export function estimateAvailability(ctx: OperationsContext, cat: OperationsCatalogue): AvailabilityEstimate {
  const a = cat.componentAvailability;
  const components: AvailabilityEstimate['components'] = [];
  // Parallel redundancy: 1 - (1 - p)^n, assuming independent failures; the site below caps it.
  const replicated = (n: number) => Math.round((1 - (1 - a.singleReplica / 100) ** Math.max(1, n)) * 1e6) / 1e4;
  components.push({ component: 'Application / gateway', percent: replicated(2), basis: '2 replicas (Infrastructure Design assumption), parallel redundancy' });
  if (ctx.inference) {
    components.push(
      ctx.inference.managed
        ? { component: 'Inference (managed)', percent: a.managedApi, basis: 'typical provider SLA (assumption)' }
        : { component: 'Inference serving', percent: replicated(ctx.inference.minReplicas), basis: `${ctx.inference.minReplicas} minimum replica(s) (Inference assessment)` },
    );
  }
  if (ctx.vector) {
    const managed = ctx.vector.kinds.every((k) => k === 'managed' || k === 'saas');
    components.push(managed ? { component: `Vector database (${ctx.vector.platform}, managed)`, percent: a.managedService, basis: 'typical managed-service SLA (assumption)' } : { component: `Vector database (${ctx.vector.platform})`, percent: replicated(ctx.vector.replicas), basis: `${ctx.vector.replicas} replica(s)` });
  }
  if (ctx.deployment) {
    for (const t of ctx.deployment.targets) {
      const onPrem = t === 'on_premises';
      const multiSite = onPrem && ctx.deployment.multipleOnPremSites;
      components.push({
        component: onPrem ? `On-premises ${multiSite ? 'sites' : 'site'}` : `Cloud region (${t.toUpperCase()})`,
        percent: onPrem ? (multiSite ? cat.siteAvailability.onPremMultiSite : cat.siteAvailability.onPremSingleSite) : cat.siteAvailability.cloudRegion,
        basis: onPrem ? (multiSite ? 'two or more independent sites (Infrastructure Design)' : 'single site (Infrastructure Design)') : 'multi-zone region (assumption)',
      });
    }
  }
  const estimated = ctx.deployment ? round2(components.reduce((p, c) => p * (c.percent / 100), 1) * 100) : null;
  return { targetPercent: ctx.availabilityTargetPercent, estimatedPercent: estimated, meets: estimated === null ? null : estimated >= ctx.availabilityTargetPercent, components };
}

/** Recovery time for the DR tier the design implies. Pure. */
export function estimateRecovery(ctx: OperationsContext, cat: OperationsCatalogue): RecoveryEstimate {
  const r = cat.recovery;
  const steps: RecoveryEstimate['steps'] = [];
  if (ctx.dr.tier === 'active') steps.push({ step: 'Traffic fails over to the active site', minutes: r.activeFailoverMinutes });
  else if (ctx.dr.tier === 'warm') steps.push({ step: 'Promote the warm standby and switch traffic', minutes: r.warmFailoverMinutes });
  else {
    const onPrem = ctx.deployment?.targets.includes('on_premises') ?? false;
    steps.push({ step: `Provision replacement capacity (${onPrem ? 'on-premises, spare hardware assumed' : 'cloud'})`, minutes: onPrem ? r.provisioningMinutes.on_premises : r.provisioningMinutes.cloud });
    if (ctx.vector) steps.push({ step: `Restore ${ctx.vector.storageGb} GB of vector data`, minutes: Math.ceil(ctx.vector.storageGb / r.restoreGbPerMinute) });
    if (ctx.inference && !ctx.inference.managed) steps.push({ step: `Load ${ctx.inference.weightsGb} GB of model weights`, minutes: Math.ceil(ctx.inference.weightsGb / r.modelLoadGbPerMinute) });
    steps.push({ step: 'Validate before taking traffic', minutes: r.validationMinutes });
  }
  const estimated = steps.reduce((s, x) => s + x.minutes, 0);
  return { tier: ctx.dr.tier, targetMinutes: ctx.rtoMinutes, estimatedMinutes: estimated, meets: ctx.rtoMinutes === null ? null : estimated <= ctx.rtoMinutes, steps };
}

/** The backup / replication method an RPO needs. Pure. */
export function planRpo(ctx: OperationsContext, cat: OperationsCatalogue): RpoPlan {
  const rpo = ctx.rpoMinutes;
  const b = cat.backup;
  if (rpo === null) return { targetMinutes: null, method: `Scheduled snapshots every ${b.snapshotIntervalMinutes} min (no RPO stated - agree one)`, conditions: ['No RPO stated in Discovery.'] };
  if (rpo === 0) return { targetMinutes: 0, method: 'Synchronous replication across failure domains', conditions: ['Adds write latency; needs a second failure domain for the vector database.'] };
  if (rpo < b.snapshotIntervalMinutes) {
    return {
      targetMinutes: rpo,
      method: rpo < b.continuousReplicationRpoMinutes ? 'Synchronous or near-synchronous replication' : `Continuous replication (log shipping / asynchronous replicas), lag alert below ${rpo} min`,
      conditions: [`Confirm ${ctx.vector?.platform ?? 'the vector database'} supports continuous replication; snapshots alone cannot meet a ${rpo}-minute RPO.`],
    };
  }
  return { targetMinutes: rpo, method: `Scheduled snapshots at least every ${Math.min(rpo, 1440)} min, plus re-ingestion from source as the fallback`, conditions: [] };
}

/** Can the team run what the design asks them to run? Pure. */
export function operationalLoad(ctx: OperationsContext, cat: OperationsCatalogue): OperationsResult['operationalLoad'] {
  const p = cat.operationalLoad.points;
  const items: Array<{ item: string; points: number }> = [];
  if (ctx.inference && !ctx.inference.managed) items.push({ item: `Self-hosted GPU serving (${ctx.inference.servingLabel})`, points: p.selfHostedGpuServing });
  if (ctx.deployment?.targets.includes('on_premises') && ctx.deployment.hasKubernetes === false && ctx.inference && !ctx.inference.managed) items.push({ item: 'Build and run on-premises Kubernetes', points: p.buildKubernetes });
  if (ctx.vector && ctx.vector.kinds.some((k) => k === 'vm' || k === 'kubernetes') && !ctx.vector.kinds.every((k) => k === 'managed' || k === 'saas')) items.push({ item: `Self-managed vector database (${ctx.vector.platform})`, points: p.selfManagedVectorDb });
  if (ctx.agentActs) items.push({ item: 'Agents with write / external actions', points: p.agentsThatAct });
  if (ctx.deployment?.kind === 'hybrid') items.push({ item: 'Hybrid deployment across targets', points: p.hybrid });
  if (ctx.dr.tier !== 'cold') items.push({ item: `${ctx.dr.tier === 'active' ? 'Active' : 'Warm'} DR site kept in sync`, points: p.standbyDr });
  const total = items.reduce((s, i) => s + i.points, 0);
  const capacity = cat.operationalLoad.capacity[ctx.opsCapability] ?? 0;
  return { items, total, capacity, opsCapability: ctx.opsCapability, withinCapacity: total <= capacity };
}

/** AI Operations Model (spec §14). Pure. */
export function assessOperations(ctx: OperationsContext, cat: OperationsCatalogue): OperationsResult {
  const sla = estimateAvailability(ctx, cat);
  const rto = estimateRecovery(ctx, cat);
  const rpo = planRpo(ctx, cat);
  const load = operationalLoad(ctx, cat);
  const own = (text: string): Statement => ({ source: THIS, text });
  const from = (a: OperationsArea) => ctx.statements[a] ?? [];
  const needsOnCall = ctx.availabilityTargetPercent >= cat.onCallAvailabilityThreshold;

  const scalingPolicy = [
    ...(ctx.inference && !ctx.inference.managed ? [`Inference: scale out before GPU utilisation passes ${ctx.inference.gpuUtilizationTarget !== null ? `${Math.round(ctx.inference.gpuUtilizationTarget * 100)}%` : 'the sizing target'}; never below ${ctx.inference.minReplicas} replica(s).`] : []),
    ...(ctx.inference?.managed ? ['Inference: provider autoscaling within the contracted quota / provisioned throughput.'] : []),
    ...(ctx.vector ? [`Vector database: add memory or shards before ${cat.capacityThresholds.vectorMemoryPercent}% memory; ${ctx.capacity ? `sharding plan: ${ctx.capacity.sharding}` : 'no Capacity plan yet'}.`] : []),
    `Application / gateway: horizontal autoscaling on CPU > ${cat.capacityThresholds.cpuPercent}% or request queue depth.`,
  ];
  const failoverStrategy = [
    ...(ctx.models?.secondary ? [`Model: circuit-break to the secondary (${ctx.models.secondary}) on errors or saturation.`] : []),
    ...(ctx.models?.fallback ? [`Model: degrade non-critical traffic to the fallback (${ctx.models.fallback}).`] : []),
    `Site: ${ctx.dr.tier} DR (${ctx.dr.reason}) - estimated recovery ~${rto.estimatedMinutes} min.`,
    ...(ctx.vector && ctx.vector.replicas >= 2 ? [`Vector database: replica promotion within the site (${ctx.vector.replicas} replicas).`] : []),
  ];
  const capacityThresholds: OperationsResult['definitions']['capacityThresholds'] = [
    ...(ctx.inference && !ctx.inference.managed && ctx.inference.gpuUtilizationTarget !== null ? [{ metric: 'GPU utilisation', threshold: `${Math.round(ctx.inference.gpuUtilizationTarget * 100)}%`, action: 'Add a replica', source: 'Inference sizing target utilisation' }] : []),
    ...(ctx.vector ? [{ metric: 'Vector DB memory', threshold: `${cat.capacityThresholds.vectorMemoryPercent}%`, action: 'Scale up or add a shard', source: 'config/operations.yaml' }] : []),
    { metric: 'Storage', threshold: `${cat.capacityThresholds.storagePercent}%`, action: 'Expand volumes', source: 'config/operations.yaml' },
    { metric: 'Application CPU', threshold: `${cat.capacityThresholds.cpuPercent}%`, action: 'Scale out', source: 'config/operations.yaml' },
    ...(ctx.capacity ? ctx.capacity.horizons.filter((h) => h.triggers.length).map((h) => ({ metric: `Growth at ${h.months} months`, threshold: h.triggers.join('; '), action: 'Plan capacity ahead of the horizon', source: `Capacity plan v${ctx.capacity!.version}` })) : []),
  ];

  // ------------------------------------------------------------------ areas
  const area = (a: OperationsArea, status: AreaResult['status'], items: Statement[], actions: string[]): AreaResult => ({ area: a, label: AREA_LABELS[a], status, items, actions });
  const designOr = (a: OperationsArea, fallback: Statement[], actions: string[], gapIfNone = false): AreaResult => {
    const up = from(a);
    if (up.length) return area(a, 'from_design', up, actions);
    return fallback.length ? area(a, 'defined_here', fallback, actions) : area(a, gapIfNone ? 'gap' : 'defined_here', fallback, actions);
  };
  const areas: AreaResult[] = [
    designOr('autoscaling', scalingPolicy.map(own), ['Test scale-out at peak before go-live.']),
    designOr('load_balancing', [], ['Health checks that only pass once the model is loaded.'], true),
    area(
      'high_availability',
      sla.meets === false ? 'gap' : sla.meets === null ? 'gap' : 'defined_here',
      [...from('high_availability'), own(sla.estimatedPercent === null ? 'No Infrastructure Design yet - availability cannot be estimated.' : `Estimated ${sla.estimatedPercent}% against a ${sla.targetPercent}% target (${sla.components.map((c) => `${c.component} ${c.percent}%`).join(' × ')}).`)],
      sla.meets === false ? ['Remove the weakest link: a second site / zone, more replicas, or a managed service with a higher SLA.'] : ['Measure availability against the SLO once live.'],
    ),
    area(
      'disaster_recovery',
      rto.meets === false ? 'gap' : 'defined_here',
      [...from('disaster_recovery'), own(`${rto.tier} DR - estimated recovery ${rto.estimatedMinutes} min${rto.targetMinutes !== null ? ` against an RTO of ${rto.targetMinutes} min` : ' (no RTO stated)'}: ${rto.steps.map((s) => `${s.step} ${s.minutes} min`).join(', ')}.`)],
      [ctx.drTested ? 'DR rehearsed - repeat after every major change.' : 'Rehearse DR end to end and record the measured recovery time.'],
    ),
    area('backup', 'defined_here', [...from('backup'), own(`${rpo.method}.`), own(`Model weights and configuration: ${ctx.modelVersionsKept} versions kept in the artefact registry.`)], rpo.conditions.length ? rpo.conditions : ['Test a restore quarterly.']),
    area('failover', ctx.models || ctx.vector ? 'defined_here' : 'gap', failoverStrategy.map(own), ['Chaos-test each failover path before go-live.']),
    ctx.models
      ? area('model_versioning', 'defined_here', [own(`Pin exact versions of ${[ctx.models.primary, ctx.models.secondary, ctx.models.fallback].filter(Boolean).join(', ')} (and the embedding model) in a registry; ${ctx.modelVersionsKept} versions kept.`), own('A model, prompt or embedding change is a release: evaluation set → canary → full rollout.')], ['Record the version served with every response (Inference Architecture observability).'])
      : area('model_versioning', 'gap', [], ['Complete Model Selection.']),
    ctx.models && ctx.modelVersionsKept >= 2
      ? area('model_rollback', 'defined_here', [own('Keep the previous version deployable; roll back by switching the gateway route, not by redeploying.'), own('Embedding-model rollback needs the previous index kept until the new one is proven.')], ['Time a rollback during the canary.'])
      : area('model_rollback', 'gap', [], ['Keep at least two model versions to make rollback possible.']),
    designOr('observability', [], ['Dashboards per SLO; trace every request end to end.'], true),
    area(
      'alerting',
      'defined_here',
      [
        own(`Availability SLO ${ctx.availabilityTargetPercent}% - alert on error-budget burn (fast and slow windows).`),
        ...(ctx.inference?.ttftTargetMs ? [own(`TTFT P95 above ${ctx.inference.ttftTargetMs} ms for 5 minutes.`)] : []),
        ...(ctx.rpoMinutes ? [own(`Replication / backup lag above ${ctx.rpoMinutes} min (RPO).`)] : []),
        ...capacityThresholds.slice(0, 4).map((t) => own(`${t.metric} above ${t.threshold}.`)),
      ],
      ['Route alerts to the on-call rota with runbooks linked.'],
    ),
    ctx.capacity
      ? area('capacity_planning', 'from_design', [...from('capacity_planning'), ...ctx.capacity.horizons.map((h) => ({ source: `Capacity plan v${ctx.capacity!.version}`, text: `${h.months} months: ~${h.storageGb} GB storage, ~${h.memoryGb} GB memory${h.triggers.length ? ` - ${h.triggers.join('; ')}` : ''}` }))], ['Review the forecast against actual growth monthly.'])
      : area('capacity_planning', 'gap', [], ['Run the Capacity plan.']),
    area(
      'upgrade_strategy',
      'defined_here',
      [
        own('Rolling / canary upgrades behind the gateway; one component at a time.'),
        ...(ctx.inference && !ctx.inference.managed ? [own('GPU driver, CUDA and runtime upgrades tested on one node pool first; pin versions per node image.')] : []),
        ...(ctx.vector ? [own(`${ctx.vector.platform}: follow the vendor upgrade path; take a snapshot first; re-index only when the index format changes.`)] : []),
        ...(ctx.inference?.managed ? [own('Provider model deprecations: track notices and re-run the evaluation set on the replacement.')] : []),
      ],
      ['Keep a maintenance calendar and change freeze windows.'],
    ),
    area(
      'incident_management',
      needsOnCall && ctx.onCallCoverage !== '24x7' ? 'gap' : 'defined_here',
      [
        // The on-call line first: it is the reason when this area is a gap.
        own(needsOnCall ? `${ctx.availabilityTargetPercent}% availability needs 24x7 on-call (on-call stated: ${(ctx.onCallCoverage ?? 'not stated').replace('_', ' ')}).` : `On-call: ${(ctx.onCallCoverage ?? 'not stated').replace('_', ' ')}.`),
        own(`Severity 1 = SLO breach or data exposure; severity 2 = degraded (fallback model, slow responses); severity 3 = single component, no user impact.`),
        own('AI-specific runbooks: model degradation, prompt-injection incident, bad index / embedding rollout, provider outage.'),
      ],
      ['Blameless post-incident reviews; feed findings into the evaluation set.'],
    ),
  ];

  // ---------------------------------------------------------------- verdict
  const gaps = [
    ...areas.filter((a) => a.status === 'gap').map((a) => `${a.label}: ${a.items.find((i) => i.source === THIS)?.text ?? 'not designed yet'}`),
    ...(!load.withinCapacity ? [`Operational load ${load.total} exceeds what a ${ctx.opsCapability.replace(/_/g, ' ')} can run (${load.capacity}).`] : []),
    ...ctx.missing.map((m) => `No ${m} yet.`),
  ];
  const reasons: string[] = [];
  let status: OperationsResult['verdict']['status'];
  const hardFails = [
    sla.meets === false && `Estimated availability ${sla.estimatedPercent}% is below the ${sla.targetPercent}% target.`,
    rto.meets === false && `Estimated recovery ${rto.estimatedMinutes} min exceeds the ${rto.targetMinutes}-minute RTO.`,
    !load.withinCapacity && `The design needs more operations capability (load ${load.total}) than a ${ctx.opsCapability.replace(/_/g, ' ')} provides (${load.capacity}).`,
    needsOnCall && ctx.onCallCoverage !== '24x7' && ctx.onCallCoverage !== null && `${ctx.availabilityTargetPercent}% availability needs 24x7 on-call; stated: ${ctx.onCallCoverage.replace('_', ' ')}.`,
  ].filter((x): x is string => !!x);
  if (hardFails.length) {
    status = 'fail';
    reasons.push(...hardFails);
  } else if (gaps.length) {
    status = 'further_assessment';
    reasons.push(`${gaps.length} gap(s) to close before the platform can be operated in production.`);
  } else {
    status = 'pass_with_conditions';
    reasons.push('The design can meet its SLA, RTO and RPO on paper and the team can run it.', EVIDENCE_NOTE);
  }

  const wouldChangeIf: string[] = [];
  if (sla.meets === false && ctx.deployment?.targets.includes('on_premises') && !ctx.deployment.multipleOnPremSites) wouldChangeIf.push('A second on-premises site (or a cloud DR target) lifts the site availability that limits the SLA.');
  if (rto.meets === false && rto.tier === 'cold') wouldChangeIf.push('A warm standby cuts recovery to minutes, at the DR cost shown in Cost & FinOps.');
  if (!load.withinCapacity) wouldChangeIf.push('Managed serving or a managed vector database reduces the operational load; so does a larger operations team.');
  if (needsOnCall && ctx.onCallCoverage !== '24x7') wouldChangeIf.push('24x7 on-call (or a lower availability target) closes the incident-management gap.');

  return {
    rulesVersion: cat.rulesVersion,
    verdict: { status, reasons },
    definitions: { rto, rpo, sla, scalingPolicy, failoverStrategy, capacityThresholds },
    areas,
    operationalLoad: load,
    gaps,
    wouldChangeIf,
    evidenceNote: EVIDENCE_NOTE,
  };
}
