import {
  EvaluatedServingOption,
  InferenceArchitectureResult,
  InferencePattern,
  LatencyEstimate,
  RouteRule,
  ServingCatalogue,
  ServingContext,
  ServingOption,
} from './inference-architecture.types';

const round = (n: number) => Math.round(n * 1000) / 1000;
const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const TARGET_LABEL: Record<string, string> = { on_premises: 'on-premises', azure: 'Azure', aws: 'AWS', oci: 'OCI', gcp: 'GCP' };
const TIE_EPSILON = 0.001;

/** Spec §3 for one serving option: mandatory rules → NOT ELIGIBLE; operational / contractual gaps → CONDITIONAL. */
export function checkServingEligibility(o: ServingOption, ctx: ServingContext, cat: ServingCatalogue) {
  const failures: string[] = [];
  const conditions: string[] = [];
  const notes: string[] = o.note ? [o.note] : [];

  if (!o.modelFamilies.some((f) => ctx.allowedFamilies.includes(f))) {
    failures.push(
      ctx.allowedFamilies.length
        ? `Serves ${o.modelFamilies.map((f) => (f === 'open_weight' ? 'self-hostable open-weight' : 'managed API')).join(' / ')} models, but the inference assessment recommends ${ctx.allowedFamilies.map((f) => (f === 'open_weight' ? 'self-hosting' : 'a managed API')).join(' or ')}.`
        : 'The inference assessment found no feasible serving option - nothing can be served.',
    );
  }
  if (ctx.deploymentTargets.length && !o.runsOn.some((t) => ctx.deploymentTargets.includes(t))) {
    failures.push(`Runs on ${o.runsOn.map((t) => TARGET_LABEL[t] ?? t).join(', ')}, none of the allowed targets (${ctx.deploymentTargets.map((t) => TARGET_LABEL[t] ?? t).join(', ')}).`);
  }
  const missingPatterns = ctx.patterns.filter((p) => !o.patterns.includes(p));
  if (missingPatterns.length) failures.push(`Does not support the ${missingPatterns.join(', ')} pattern(s) the workload needs.`);
  if (ctx.precision && !o.precisions.includes('provider') && !o.precisions.includes(ctx.precision) && o.modelFamilies.includes('open_weight')) {
    failures.push(`Cannot serve the sized precision (${ctx.precision.toUpperCase()}).`);
  }
  if (ctx.tensorParallel > 1 && !o.multiGpuTensorParallel) failures.push(`Cannot split a model across ${ctx.tensorParallel} GPUs (tensor parallelism), which the sizing requires.`);
  if (o.maxModelParamsB !== undefined && ctx.modelParamsB !== null && ctx.modelParamsB > o.maxModelParamsB) failures.push(`${ctx.modelParamsB}B-parameter model exceeds the ${o.maxModelParamsB}B this runtime handles.`);
  if (ctx.needsMultiLora && o.modelFamilies.includes('open_weight') && !o.features.includes('multi_lora')) failures.push('No multi-LoRA adapter serving, which the fine-tuning approach needs.');

  if (o.requiresKubernetes) {
    if (ctx.hasKubernetes === false) conditions.push('Needs a Kubernetes platform, and none exists today - add one (or pick a non-Kubernetes option).');
    else if (ctx.hasKubernetes === null) conditions.push('Needs Kubernetes - availability not stated.');
  }
  if (o.requiresGpu && ctx.hasGpu === false && ctx.deploymentTargets.length > 0 && ctx.deploymentTargets.every((t) => t === 'on_premises')) {
    conditions.push('Needs GPUs on-premises, and none are available today - procurement lead time applies.');
  }
  const capacity = cat.opsCapacity[ctx.opsCapability] ?? 3;
  if (o.opsComplexity > capacity) conditions.push(`Operational complexity ${o.opsComplexity}/5 exceeds what the current ${ctx.opsCapability.replace(/_/g, ' ')} capability runs comfortably (${capacity}/5).`);
  if (o.modelFamilies.includes('proprietary_api') && ctx.restrictedData) conditions.push('Restricted data (PHI / PCI) needs a signed BAA / DPA with zero data retention.');
  if (!o.runsOn.includes('on_premises') && ctx.dataResidency) conditions.push(`Confirm the provider region keeps inference inside "${ctx.dataResidency}".`);

  return { eligibility: failures.length ? ('not_eligible' as const) : conditions.length ? ('conditional' as const) : ('eligible' as const), failures, conditions, notes };
}

export function scoreServingOption(o: ServingOption, ctx: ServingContext, cat: ServingCatalogue) {
  const wanted = new Set<string>([
    ...(ctx.patterns.includes('streaming') ? cat.desiredFeatures.streaming ?? [] : []),
    ...(ctx.peakRps >= 5 ? cat.desiredFeatures.highConcurrency ?? [] : []),
    ...(ctx.routing?.secondary || ctx.routing?.fallback ? cat.desiredFeatures.multiModelRouting ?? [] : []),
  ]);
  const criteria = {
    performance: o.performanceTier / 5,
    operationalSimplicity: (6 - o.opsComplexity) / 5,
    maturity: o.maturityTier / 5,
    cost: o.costTier / 5,
    // Managed services run batching / caching inside the provider's stack, so they satisfy these serving-internal features by construction.
    featureFit: wanted.size ? [...wanted].filter((f) => o.features.includes(f) || o.features.includes('managed_autoscaling')).length / wanted.size : 1,
  };
  const w = cat.scoringWeights;
  const score = round(Object.entries(criteria).reduce((s, [k, v]) => s + v * (w[k as keyof typeof w] ?? 0), 0));
  return { score, criteria: Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, round(v)])) };
}

const band = (e: EvaluatedServingOption) => (e.eligibility === 'eligible' ? 0 : e.eligibility === 'conditional' ? 1 : 2);

/**
 * Inference Architecture (spec §8): choose the serving option (eligibility →
 * score), then design the layers around it - API, gateway, policy, router,
 * runtime, compute - with replica, autoscaling, load-balancing, fallback,
 * SLA, observability, security and cost decisions. Pure.
 */
export function designInferenceArchitecture(ctx: ServingContext, cat: ServingCatalogue): InferenceArchitectureResult {
  const candidates: EvaluatedServingOption[] = cat.servingOptions
    .map((o) => ({ id: o.id, label: o.label, ...checkServingEligibility(o, ctx, cat), ...scoreServingOption(o, ctx, cat) }))
    .sort((a, b) => band(a) - band(b) || (Math.abs(b.score - a.score) > TIE_EPSILON ? b.score - a.score : a.id.localeCompare(b.id)));
  const usable = candidates.filter((c) => c.eligibility !== 'not_eligible');
  const recommended = usable[0] ?? null;
  const runnerUp = usable[1];
  const confidence: InferenceArchitectureResult['confidence'] = !recommended
    ? 'low'
    : recommended.eligibility === 'conditional' || (runnerUp && recommended.score - runnerUp.score < 0.05)
      ? 'medium'
      : 'high';

  const why: string[] = [];
  if (!recommended) {
    why.push('No serving option meets every mandatory requirement - see each option\'s reasons below.');
  } else {
    const tied = runnerUp && runnerUp.eligibility === recommended.eligibility && Math.abs(recommended.score - runnerUp.score) <= TIE_EPSILON;
    why.push(
      tied
        ? `${recommended.label} and ${runnerUp!.label} are tied at ${recommended.score}; broken alphabetically - treat them as interchangeable and decide on team familiarity.`
        : `${recommended.label} has the highest weighted score (${recommended.score}) among ${usable.length} usable option(s); ${candidates.length - usable.length} failed a mandatory requirement.`,
    );
    const higherConditional = usable.filter((c) => c.eligibility === 'conditional' && c.score > recommended.score);
    if (recommended.eligibility === 'eligible' && higherConditional.length) {
      why.push(`${higherConditional[0].label} scores higher (${higherConditional[0].score}) but only with conditions: ${higherConditional[0].conditions[0]}`);
    }
    if (recommended.eligibility === 'conditional') why.push(`Recommended with conditions: ${recommended.conditions.join(' ')}`);
  }
  const wouldChangeIf = [
    ...candidates.filter((c) => c.eligibility === 'not_eligible' && recommended && c.score > recommended.score).map((c) => `${c.label} would score higher (${c.score}) but: ${c.failures[0]}`),
    ...(ctx.hasKubernetes === false ? ['A Kubernetes platform becomes available - unlocks the Kubernetes-based serving options without conditions.'] : []),
    'The inference assessment changes model, precision or GPU split, or the required inference patterns change.',
  ];

  const option = recommended ? cat.servingOptions.find((o) => o.id === recommended.id)! : null;
  return {
    rulesVersion: cat.rulesVersion,
    recommended,
    candidates,
    confidence,
    why,
    wouldChangeIf,
    architecture: option ? buildArchitecture(ctx, option, cat) : null,
    benchmarkRequired: [
      `Load-test the full path (gateway → router → ${option?.runtime ?? 'runtime'}) at ${ctx.peakRps.toFixed(2)} req/s peak and confirm P95 / P99 TTFT and time per token - the percentiles here are estimates.`,
      ...(recommended?.conditions ?? []).map((c) => `Validate: ${c}`),
      ...(ctx.routing?.secondary ? ['Fail over from the primary to the secondary model under load and confirm quality and latency stay within SLA.'] : []),
    ],
  };
}

export function estimateLatency(ctx: ServingContext, cat: ServingCatalogue): LatencyEstimate[] {
  const f = cat.latencyTailFactors;
  const row = (metric: string, base: number | null, target: number | null): LatencyEstimate[] =>
    base === null
      ? []
      : [{ metric, p50: Math.round(base * f.p50), p95: Math.round(base * f.p95), p99: Math.round(base * f.p99), targetMs: target, meetsTargetAtP95: target === null ? null : base * f.p95 <= target }];
  return [...row('Time to first token', ctx.ttftMs, ctx.ttftTargetMs), ...row('Time per output token', ctx.tpotMs, ctx.tpotTargetMs), ...row('End-to-end response', ctx.e2eMs, null)];
}

export function buildRoutes(ctx: ServingContext): RouteRule[] {
  const r = ctx.routing;
  if (!r?.primary) return [{ when: 'Every request', routeTo: ctx.apiTierLabel ?? ctx.modelLabel, why: 'Single model - no Model Selection with alternatives yet.' }];
  const inBoundary = (m: { family: string } | null) => !!m && m.family === 'open_weight';
  const rules: RouteRule[] = [];
  if (ctx.restrictedData) {
    const safe = [r.primary, r.secondary, r.fallback].filter(inBoundary);
    rules.push({
      when: 'Request carries restricted data (PHI / PCI)',
      routeTo: safe.length ? safe.map((m) => m!.label).join(' → ') : 'Reject (no in-boundary model)',
      why: 'Data classification: restricted data never leaves the customer boundary.',
    });
  }
  rules.push({ when: 'Default', routeTo: r.primary.label, why: 'Primary model from Model Selection.' });
  if (r.fallback) rules.push({ when: 'Short / simple request, or tenant over token budget', routeTo: r.fallback.label, why: 'Cost and latency: the fastest / cheapest usable model.' });
  if (r.secondary) rules.push({ when: 'Primary unhealthy, over capacity, or regional outage', routeTo: r.secondary.label, why: 'Availability: alternative deployment family / runner-up.' });
  return rules;
}

function buildArchitecture(ctx: ServingContext, o: ServingOption, cat: ServingCatalogue): NonNullable<InferenceArchitectureResult['architecture']> {
  const managed = !o.requiresGpu && o.gpuVendors.includes('provider');
  const primaryPattern: InferencePattern = ctx.patterns.includes('real_time') ? 'real_time' : ctx.patterns.includes('streaming') ? 'streaming' : ctx.patterns[0] ?? 'synchronous';
  const scaleToZero = ctx.patterns.every((p) => p === 'batch' || p === 'asynchronous');
  const latency = estimateLatency(ctx, cat);
  const routes = buildRoutes(ctx);

  const inferenceApi = [
    o.features.includes('openai_compatible_api') ? 'OpenAI-compatible REST API (chat / completions), so clients and SDKs stay portable across runtimes' : 'Runtime-native API, normalised to one schema at the gateway',
    ...(ctx.patterns.includes('streaming') ? ['Token streaming over server-sent events'] : []),
    ...(ctx.patterns.includes('asynchronous') ? ['Asynchronous submit + poll / callback through a durable queue'] : []),
    ...(ctx.patterns.includes('batch') ? ['Batch job API (file in, file out) run off-peak'] : []),
  ];
  const gateway = [
    'Authentication (OIDC / workload identity) and per-application authorisation',
    ctx.multiTenant ? 'Per-tenant quotas (requests and tokens per minute) and token accounting for chargeback' : 'Per-application rate limits and token accounting for showback',
    'Request size / max-token limits and timeouts per pattern',
  ];
  const policy = [
    ...(ctx.restrictedData ? ['Restricted data (PHI / PCI) is routed only to in-boundary models - enforced before routing'] : []),
    ...(ctx.containsPii ? ['PII detection and redaction before any prompt leaves the trust boundary'] : []),
    ...(ctx.dataResidency ? [`Pin every inference call to regions inside "${ctx.dataResidency}"`] : []),
    'Prompt-injection screening on inputs and content filtering on outputs',
  ];
  const runtime = [
    `${o.runtime}${managed ? '' : ` serving ${ctx.modelLabel}`}${ctx.precision && !managed ? ` at ${ctx.precision.toUpperCase()}` : ''}${ctx.tensorParallel > 1 ? `, tensor-parallel across ${ctx.tensorParallel} GPUs` : ''}`,
    ...o.features.filter((f) => f !== 'openai_compatible_api').map((f) => f.replace(/_/g, ' ')),
    `Licence: ${o.licence}`,
  ];
  const compute = managed
    ? [`Provider-managed capacity (${ctx.apiTierLabel ?? ctx.modelLabel}) - no GPUs to operate`]
    : !o.requiresGpu
      ? ['CPU nodes sized for a quantised small model - validate throughput before committing']
      : [`${ctx.totalGpusAtPeak ?? '?'} × ${ctx.gpuLabel ?? 'GPU'} at peak (from the inference assessment)`, ...ctx.deploymentTargets.map((t) => `Available on ${TARGET_LABEL[t] ?? t}`)];
  const replicaStrategy = ctx.replicas
    ? [`Minimum ${ctx.replicas.min} replica(s) (availability ${ctx.availabilityTargetPercent}%) spread across failure domains`, `~${ctx.replicas.average} at average load, ${ctx.replicas.peak} at peak`]
    : ['Provider-managed replicas - reserve capacity / provisioned throughput if the SLA needs guaranteed headroom'];
  const autoscaling = managed
    ? ['Provider autoscaling; set quota / provisioned-throughput limits to cap spend']
    : [`Scale on: ${cat.autoscalingSignals[primaryPattern]}`, scaleToZero ? 'Scale to zero between batches (asynchronous / batch only)' : `Never below ${ctx.replicas?.min ?? 1} warm replica(s) - model load time rules out cold starts`, 'Scale up before the KV cache is full; scale down slowly (model reload is expensive)'];
  const loadBalancing = [
    'Least-outstanding-requests balancing (request cost varies with prompt and output length)',
    ...(o.features.includes('prefix_caching') ? ['Prefix-aware routing so requests sharing a system prompt / RAG context reuse the KV cache'] : []),
    'Readiness only after the model is loaded; drain in-flight streams before shutdown',
  ];
  const fallback = [
    ...(ctx.routing?.secondary ? [`Circuit breaker to the secondary (${ctx.routing.secondary.label}) on errors or saturation`] : []),
    ...(ctx.routing?.fallback ? [`Degrade to the fallback (${ctx.routing.fallback.label}) for non-critical traffic under load`] : []),
    'Return a clear "busy" response with retry-after rather than queueing past the latency SLA',
  ];
  const targets = [`Time to first token ≤ ${ms(ctx.ttftTargetMs)} (treated as the P95 target)`, `Time per output token ≤ ${ms(ctx.tpotTargetMs)}`, `Availability ${ctx.availabilityTargetPercent}%`];
  const observability = [
    'Per-request TTFT, time per token, tokens in/out, route taken and model version',
    'Queue depth, KV-cache utilisation, GPU utilisation / memory, error and throttle rates',
    'Distributed tracing gateway → router → runtime; alert on P95 TTFT and error budget burn',
    ctx.containsPii || ctx.restrictedData ? 'Prompt / response logging only after redaction, with a retention limit' : 'Sampled prompt / response logging with a retention limit',
  ];
  const cost = [
    ...(ctx.monthlyCostUsd !== null ? [{ label: 'Serving cost (from the inference assessment)', value: `${usd(ctx.monthlyCostUsd)} / month`, evidenceType: 'estimated' as const }] : []),
    { label: 'Gateway, router and observability', value: 'Not yet estimated - consolidated in the Cost phase (Wave 9)', evidenceType: 'assumption' as const },
  ];

  return {
    layers: [
      { layer: 'Application', component: 'AI application / agents', detail: ctx.patterns.join(', ') },
      { layer: 'Inference gateway', component: 'API gateway', detail: gateway[1] },
      { layer: 'Policy engine', component: 'Policy enforcement', detail: policy[0] },
      { layer: 'Model router', component: 'Rule-based router', detail: `${routes.length} route(s)` },
      { layer: 'Inference runtime', component: o.label, detail: runtime[0] },
      { layer: managed ? 'Managed capacity' : o.requiresGpu ? 'GPU' : 'CPU', component: compute[0], detail: ctx.deploymentTargets.map((t) => TARGET_LABEL[t] ?? t).join(' + ') || 'deployment target not stated' },
    ],
    inferenceApi,
    gateway,
    policy,
    routes,
    runtime,
    compute,
    replicaStrategy,
    autoscaling,
    loadBalancing,
    fallback,
    sla: { targets, latency },
    observability,
    security: ctx.securityControls.length ? ctx.securityControls : ['Encryption in transit (TLS 1.2+)', 'Authentication on every inference endpoint'],
    cost,
  };
}
