import { Injectable } from '@nestjs/common';
import { InferenceConfigService } from './inference-config.service';
import {
  BreakEvenAnalysis,
  BreakEvenPoint,
  CalculationStep,
  DemandProfile,
  GpuOption,
  GpuPricingModel,
  GpuSpec,
  InferenceAssessmentResult,
  InferenceDecision,
  InferenceEngineInput,
  InferenceForecastPoint,
  InferenceOpsCapability,
  ManagedApiCost,
  ModelFootprint,
  ModelSourcing,
  ModelSpec,
  PrecisionSpec,
} from './inference.types';

const GB = 1e9;
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const usd2 = (n: number) => '$' + n.toFixed(n < 1 ? 4 : 2);
const fx = (n: number, d = 1) => Number(n.toFixed(d)).toLocaleString('en-US');

/**
 * Inference Assessment engine: GPU sizing, cost per token, managed-API vs
 * self-hosted break-even, and growth forecast. Pure/stateless - everything it
 * knows comes from InferenceConfigService, so it is unit-testable without a DB.
 *
 * Performance model (a roofline approximation, documented in `workings`):
 *  - Weights     = paramsB x 1e9 x bytesPerParam, sharded across tensor-parallel (TP) GPUs.
 *  - KV cache    = 2 (K,V) x layers x kvHeads x headDim x kvBytes per token.
 *  - Decode step = (active weight bytes + batch x KV bytes read) / (TP x HBM bandwidth x efficiency x TP efficiency).
 *                  Decode is memory-bandwidth bound, so one step serves the whole batch.
 *  - Prefill     = max(2 x activeParams x inputTokens / (TP x TFLOPS x MFU), weight read time).
 *  - Batch       = min(what fits in leftover KV memory, what keeps the step time under the TPOT target, scheduler cap).
 *  - Capacity    = targetUtilization / GPU-seconds per request, where a request costs its prefill plus
 *                  its share (1/batch) of every decode step it takes part in.
 */
@Injectable()
export class InferenceEngineService {
  constructor(private readonly cfg: InferenceConfigService) {}

  // ------------------------------------------------------------------ demand
  demand(input: InferenceEngineInput, scale = 1): DemandProfile {
    const pricing = this.cfg.getPricing();
    const requestsPerDay = input.requestsPerDay * scale;
    const avgRps = requestsPerDay / 86400;
    const peakRps = avgRps * Math.max(1, input.peakToAverageRatio);
    const tokensPerRequest = input.avgInputTokens + input.avgOutputTokens;
    return {
      requestsPerDay,
      avgRps,
      peakRps,
      tokensPerDay: requestsPerDay * tokensPerRequest,
      requestsPerMonth: requestsPerDay * pricing.daysPerMonth,
      tokensPerMonth: requestsPerDay * pricing.daysPerMonth * tokensPerRequest,
      peakOutputTokensPerSec: peakRps * input.avgOutputTokens,
      peakPrefillTokensPerSec: peakRps * input.avgInputTokens,
    };
  }

  // --------------------------------------------------------------- footprint
  footprint(model: ModelSpec, precision: PrecisionSpec, input: InferenceEngineInput): ModelFootprint {
    const kvBytesPerToken = 2 * model.layers * model.kvHeads * model.headDim * precision.kvBytes;
    return {
      weightsGb: (model.paramsB * GB * precision.bytesPerParam) / GB,
      kvBytesPerToken,
      kvGbPerAvgSequence: (kvBytesPerToken * (input.avgInputTokens + input.avgOutputTokens)) / GB,
      kvGbPerMaxContextSequence: (kvBytesPerToken * this.effectiveMaxContext(input)) / GB,
    };
  }

  private effectiveMaxContext(input: InferenceEngineInput): number {
    return Math.min(input.maxContextTokens, input.model.maxContextTokens);
  }

  private hourlyRate(gpu: GpuSpec, pricingModel: GpuPricingModel): number {
    const p = this.cfg.getPricing();
    if (pricingModel === GpuPricingModel.RESERVED_1YR) return gpu.hourlyUsd * p.reserved1yrFactor;
    if (pricingModel === GpuPricingModel.SPOT) return gpu.hourlyUsd * p.spotFactor;
    return gpu.hourlyUsd;
  }

  private minReplicas(input: InferenceEngineInput): number {
    return input.availabilityTargetPercent >= this.cfg.getSizing().haAvailabilityThreshold ? 2 : 1;
  }

  // ------------------------------------------------------------ one GPU x TP
  /** Serving characteristics of one (gpu, precision, TP) configuration, or null if the model does not fit. */
  private evaluateConfig(gpu: GpuSpec, precision: PrecisionSpec, tp: number, input: InferenceEngineInput, demand: DemandProfile): GpuOption | null {
    const s = this.cfg.getSizing();
    const fp = this.footprint(input.model, precision, input);
    const usablePerGpuGb = gpu.memoryGb * s.gpuMemoryUtilization - s.runtimeOverheadGbPerGpu;
    const kvCapacityGb = tp * usablePerGpuGb - fp.weightsGb;
    // Must hold the weights plus at least one maximum-context request.
    if (kvCapacityGb < fp.kvGbPerMaxContextSequence) return null;

    const pciePenalty = tp > 1 && gpu.interconnect === 'pcie' ? s.pcieTensorParallelFactor ?? 1 : 1;
    const tpEff = (s.tensorParallelEfficiency?.[String(tp)] ?? 1) * pciePenalty;
    const effBandwidth = tp * gpu.bandwidthGbps * GB * s.bandwidthEfficiency * tpEff; // bytes/s
    const activeWeightBytes = input.model.activeParamsB * GB * precision.bytesPerParam;
    const avgDecodeContext = input.avgInputTokens + input.avgOutputTokens / 2;
    const kvReadPerSeq = fp.kvBytesPerToken * avgDecodeContext;
    const stepSeconds = (b: number) => (activeWeightBytes + b * kvReadPerSeq) / effBandwidth;

    const maxBatchByMemory = Math.floor((kvCapacityGb * GB) / (fp.kvBytesPerToken * (input.avgInputTokens + input.avgOutputTokens)));
    const tpotBudget = input.tpotTargetMs / 1000;
    const maxBatchByTpot = Math.max(0, Math.floor((tpotBudget * effBandwidth - activeWeightBytes) / kvReadPerSeq));
    const batchSize = Math.max(1, Math.min(maxBatchByMemory, maxBatchByTpot, s.maxBatchPerReplica));

    const tflops = (precision.computeUsesFp8 && gpu.fp8Tflops ? gpu.fp8Tflops : gpu.fp16Tflops) * 1e12;
    const prefillCompute = (2 * input.model.activeParamsB * GB * input.avgInputTokens) / (tp * tflops * s.prefillMfu * tpEff);
    const prefillSeconds = Math.max(prefillCompute, activeWeightBytes / effBandwidth);

    const step = stepSeconds(batchSize);
    const ttftMs = (prefillSeconds * s.ttftContentionFactor + step) * 1000;
    const tpotMs = step * 1000;
    const e2eLatencyMs = ttftMs + input.avgOutputTokens * tpotMs;

    const gpuSecondsPerRequest = prefillSeconds + (input.avgOutputTokens * step) / batchSize;
    const replicaCapacityRps = s.targetUtilization / gpuSecondsPerRequest;

    // Replica counts and costs are filled in by priceOption() for the given demand.
    const opt: GpuOption = {
      gpuId: gpu.id,
      gpuLabel: gpu.label,
      precision: precision.id,
      tensorParallel: tp,
      footprint: fp,
      kvCapacityGb,
      maxBatchByMemory,
      maxBatchByTpot,
      batchSize,
      ttftMs,
      tpotMs,
      e2eLatencyMs,
      replicaCapacityRps,
      replicasAtPeak: 0,
      replicasAtAverage: 0,
      minReplicas: this.minReplicas(input),
      totalGpusAtPeak: 0,
      gpuHourlyUsd: this.hourlyRate(gpu, input.gpuPricing),
      monthlyGpuCostPeakUsd: 0,
      monthlyGpuCostAutoscaledUsd: 0,
      monthlyTotalUsd: 0,
      costPerMillionTokensUsd: 0,
      costPerRequestUsd: 0,
      meetsTtft: ttftMs <= input.ttftTargetMs,
      meetsTpot: maxBatchByTpot >= 1,
      notes: [],
    };
    this.priceOption(opt, input, demand);
    if (!opt.meetsTpot) opt.notes.push(`A single request already needs ${fx(tpotMs)} ms per token - above the ${input.tpotTargetMs} ms TPOT target even unbatched.`);
    if (!opt.meetsTtft) opt.notes.push(`Estimated TTFT ${fx(ttftMs, 0)} ms exceeds the ${input.ttftTargetMs} ms target - prompt of ${input.avgInputTokens} tokens is prefill-bound on this GPU.`);
    if (maxBatchByMemory < s.maxBatchPerReplica && batchSize === maxBatchByMemory) opt.notes.push(`Batch limited by KV-cache memory (${fx(kvCapacityGb)} GB free after weights).`);
    if (pciePenalty < 1) opt.notes.push(`Model split across ${tp} PCIe GPUs (no NVLink) - tensor-parallel traffic slows each step; confirm with a load test.`);
    if (precision.id !== 'fp16') opt.notes.push(precision.qualityNote);
    if (input.gpuPricing === GpuPricingModel.SPOT) opt.notes.push('Spot capacity can be reclaimed at short notice - unsuitable as the only capacity for a latency SLO.');
    return opt;
  }

  /** (Re)prices an option for a demand level - replicas scale with demand, per-replica capacity does not. */
  private priceOption(opt: GpuOption, input: InferenceEngineInput, demand: DemandProfile) {
    const p = this.cfg.getPricing();
    const replicasFor = (rps: number) => Math.max(opt.minReplicas, Math.ceil(rps / opt.replicaCapacityRps));
    opt.replicasAtPeak = replicasFor(demand.peakRps);
    opt.replicasAtAverage = replicasFor(demand.avgRps);
    opt.totalGpusAtPeak = opt.replicasAtPeak * opt.tensorParallel;
    const gpuMonth = opt.tensorParallel * opt.gpuHourlyUsd * p.hoursPerMonth;
    opt.monthlyGpuCostPeakUsd = opt.replicasAtPeak * gpuMonth;
    const blendedReplicas = opt.replicasAtAverage * (1 - p.peakHoursFraction) + opt.replicasAtPeak * p.peakHoursFraction;
    opt.monthlyGpuCostAutoscaledUsd = blendedReplicas * gpuMonth;
    const gpuCost = input.autoscaling ? opt.monthlyGpuCostAutoscaledUsd : opt.monthlyGpuCostPeakUsd;
    opt.monthlyTotalUsd = gpuCost * (1 + p.selfHostedOverheadPercent / 100) + p.platformFixedMonthlyUsd;
    opt.costPerMillionTokensUsd = demand.tokensPerMonth > 0 ? opt.monthlyTotalUsd / (demand.tokensPerMonth / 1e6) : 0;
    opt.costPerRequestUsd = demand.requestsPerMonth > 0 ? opt.monthlyTotalUsd / demand.requestsPerMonth : 0;
  }

  // -------------------------------------------------------- self-hosted list
  /** Best tensor-parallel degree per (GPU, precision): cheapest config meeting both SLOs, else the lowest-latency one. */
  selfHostedOptions(input: InferenceEngineInput, demand: DemandProfile): GpuOption[] {
    const s = this.cfg.getSizing();
    const precisionIds = input.precision === 'auto' ? this.cfg.getAutoPrecisions() : [input.precision];
    const precisions = this.cfg.getPrecisions().filter((p) => precisionIds.includes(p.id));
    const gpus = this.cfg.getGpus().filter((g) => !input.allowedGpuIds?.length || input.allowedGpuIds.includes(g.id));
    const options: GpuOption[] = [];
    for (const gpu of gpus) {
      for (const precision of precisions) {
        if (precision.requiresFp8Hardware && !gpu.fp8Tflops) continue;
        const configs = (s.tensorParallelOptions as number[])
          .map((tp) => this.evaluateConfig(gpu, precision, tp, input, demand))
          .filter((o): o is GpuOption => o !== null);
        if (!configs.length) continue;
        const meeting = configs.filter((o) => o.meetsTtft && o.meetsTpot).sort((a, b) => a.monthlyTotalUsd - b.monthlyTotalUsd);
        options.push(meeting[0] ?? configs.sort((a, b) => a.e2eLatencyMs - b.e2eLatencyMs)[0]);
      }
    }
    return options.sort((a, b) => this.rank(a) - this.rank(b) || a.monthlyTotalUsd - b.monthlyTotalUsd);
  }

  private rank(o: GpuOption): number {
    return (o.meetsTtft ? 0 : 1) + (o.meetsTpot ? 0 : 1);
  }

  private cheapestMeeting(options: GpuOption[]): GpuOption | null {
    return options.filter((o) => o.meetsTtft && o.meetsTpot).sort((a, b) => a.monthlyTotalUsd - b.monthlyTotalUsd)[0] ?? null;
  }

  /** Cheapest SLO-compliant self-hosted cost at another demand level (re-prices a copy of each option). */
  private selfHostedAt(options: GpuOption[], input: InferenceEngineInput, demand: DemandProfile): GpuOption | null {
    const repriced = options.filter((o) => o.meetsTtft && o.meetsTpot).map((o) => {
      const copy: GpuOption = { ...o, notes: [...o.notes] };
      this.priceOption(copy, input, demand);
      return copy;
    });
    return this.cheapestMeeting(repriced);
  }

  // -------------------------------------------------------------- managed API
  managedApiCost(input: InferenceEngineInput, demand: DemandProfile): ManagedApiCost {
    const t = input.managedApiTier;
    const monthlyUsd = demand.requestsPerMonth * (input.avgInputTokens * t.inputPer1M + input.avgOutputTokens * t.outputPer1M) / 1e6;
    const excluded = !input.allowThirdPartyApi || input.modelSourcing === ModelSourcing.SELF_HOSTED;
    return {
      tierId: t.id,
      tierLabel: t.label,
      inputPer1M: t.inputPer1M,
      outputPer1M: t.outputPer1M,
      monthlyUsd,
      costPerRequestUsd: demand.requestsPerMonth > 0 ? monthlyUsd / demand.requestsPerMonth : 0,
      costPerMillionTokensUsd: demand.tokensPerMonth > 0 ? monthlyUsd / (demand.tokensPerMonth / 1e6) : 0,
      excluded,
      exclusionReason: !input.allowThirdPartyApi
        ? 'Data may not be sent to a third-party model API (policy / residency constraint).'
        : excluded
          ? 'Customer scoped the assessment to self-hosted serving only.'
          : undefined,
    };
  }

  // ---------------------------------------------------------------- break-even
  breakEven(input: InferenceEngineInput, options: GpuOption[]): BreakEvenAnalysis {
    const scan = this.cfg.getBreakEvenScan();
    const curve: BreakEvenPoint[] = [];
    let breakEven: number | null = null;
    for (let i = 0; i < scan.points; i++) {
      const scale = scan.minScale * Math.pow(scan.maxScale / scan.minScale, i / (scan.points - 1));
      const d = this.demand(input, scale);
      const self = this.selfHostedAt(options, input, d);
      const api = this.managedApiCost(input, d).monthlyUsd;
      curve.push({ requestsPerDay: Math.round(d.requestsPerDay), managedApiMonthlyUsd: api, selfHostedMonthlyUsd: self ? self.monthlyTotalUsd : null });
      if (breakEven === null && self && self.monthlyTotalUsd <= api) breakEven = Math.round(d.requestsPerDay);
    }
    const lo = Math.round(input.requestsPerDay * scan.minScale), hi = Math.round(input.requestsPerDay * scan.maxScale);
    let note: string;
    if (!options.some((o) => o.meetsTtft && o.meetsTpot)) note = 'No self-hosted configuration meets the latency targets, so there is no break-even point.';
    else if (breakEven === null) note = `Managed API stays cheaper across the whole range scanned (${lo.toLocaleString()} – ${hi.toLocaleString()} requests/day).`;
    else if (breakEven <= lo) note = `Self-hosting is already cheaper at ${lo.toLocaleString()} requests/day, the bottom of the range scanned.`;
    else note = `Self-hosting becomes cheaper from about ${breakEven.toLocaleString()} requests/day (current: ${Math.round(input.requestsPerDay).toLocaleString()}).`;
    return { breakEvenRequestsPerDay: breakEven, note, curve };
  }

  // ---------------------------------------------------------------- forecast
  forecast(input: InferenceEngineInput, options: GpuOption[]): InferenceForecastPoint[] {
    return this.cfg.getForecastHorizons().map((h) => {
      const scale = Math.pow(1 + input.monthlyGrowthPercent / 100, h);
      const d = this.demand(input, scale);
      const self = this.selfHostedAt(options, input, d);
      return {
        horizonMonths: h,
        requestsPerDay: Math.round(d.requestsPerDay),
        selfHostedMonthlyUsd: self ? self.monthlyTotalUsd : null,
        selfHostedGpuId: self ? self.gpuId : null,
        selfHostedTotalGpus: self ? self.totalGpusAtPeak : null,
        managedApiMonthlyUsd: this.managedApiCost(input, d).monthlyUsd,
      };
    });
  }

  // ------------------------------------------------------------------ assess
  assess(input: InferenceEngineInput): InferenceAssessmentResult {
    const p = this.cfg.getPricing();
    const s = this.cfg.getSizing();
    const demand = this.demand(input);
    const risks: string[] = [];
    const rationale: string[] = [];

    const selfHostedInScope = input.modelSourcing !== ModelSourcing.MANAGED_API;
    const options = this.selfHostedOptions(input, demand);
    const recommended = this.cheapestMeeting(options);
    const managedApi = this.managedApiCost(input, demand);
    const apiAllowed = !managedApi.excluded;

    // ---- decision
    let decision: InferenceDecision;
    if (!selfHostedInScope) {
      decision = apiAllowed ? 'managed_api' : 'none_feasible';
      rationale.push('Assessment scoped to managed APIs only; self-hosted figures are shown for reference.');
    } else if (!recommended && !apiAllowed) {
      decision = 'none_feasible';
      rationale.push('No self-hosted configuration meets the latency targets and a third-party API is not permitted - relax the TTFT/TPOT targets, pick a smaller model, or allow more GPU types.');
    } else if (!recommended) {
      decision = 'managed_api';
      rationale.push(`No self-hosted ${input.model.label} configuration meets TTFT <= ${input.ttftTargetMs} ms and TPOT <= ${input.tpotTargetMs} ms on the GPUs allowed.`);
    } else if (!apiAllowed) {
      decision = 'self_hosted';
      rationale.push(managedApi.exclusionReason ?? 'Managed API excluded.');
    } else {
      const self = recommended.monthlyTotalUsd, api = managedApi.monthlyUsd;
      const margin = p.decisionMarginPercent / 100;
      if (self < api * (1 - margin)) {
        decision = 'self_hosted';
        rationale.push(`Self-hosted ${usd(self)}/month is ${Math.round((1 - self / api) * 100)}% below the managed API's ${usd(api)}/month.`);
      } else if (api < self * (1 - margin)) {
        decision = 'managed_api';
        rationale.push(`Managed API ${usd(api)}/month is ${Math.round((1 - api / self) * 100)}% below self-hosting's ${usd(self)}/month (GPUs + ${p.selfHostedOverheadPercent}% overhead + ${usd(p.platformFixedMonthlyUsd)} platform team).`);
      } else {
        decision = 'either';
        rationale.push(`Costs are within ${p.decisionMarginPercent}% of each other (self-hosted ${usd(self)} vs API ${usd(api)} per month) - decide on data control, model choice, and operating capability rather than price.`);
      }
    }
    if (recommended && decision !== 'managed_api') {
      rationale.push(`Recommended serving: ${recommended.replicasAtPeak} × ${recommended.tensorParallel > 1 ? recommended.tensorParallel + '-GPU ' : ''}${recommended.gpuLabel} replica(s) at ${recommended.precision.toUpperCase()} (${recommended.totalGpusAtPeak} GPUs at peak).`);
    }

    // ---- risks
    if (input.maxContextTokens > input.model.maxContextTokens) {
      risks.push(`Requested max context ${input.maxContextTokens.toLocaleString()} tokens exceeds ${input.model.label}'s ${input.model.maxContextTokens.toLocaleString()} - sized at the model limit; long inputs must be truncated or chunked.`);
    }
    if (decision === 'self_hosted' || decision === 'either') {
      if (input.opsCapability === InferenceOpsCapability.NONE || input.opsCapability === InferenceOpsCapability.PART_TIME) {
        risks.push('Self-hosted GPU serving needs on-call MLOps capability (driver/runtime upgrades, autoscaling, capacity reservations) - current operating capability is limited.');
      }
      risks.push(`Model licence: ${input.model.licence}.`);
    }
    if (apiAllowed && input.containsPii) {
      risks.push('PII in prompts: confirm the API provider\'s data-retention terms (zero-retention option), regional processing, and apply PII redaction before prompts leave the boundary.');
    }
    if (input.dataResidencyRequirement) {
      risks.push(`Data residency "${input.dataResidencyRequirement}": the inference endpoint (API region or GPU region) must be inside this boundary - check regional model and GPU availability.`);
    }
    if (input.gpuPricing === GpuPricingModel.SPOT) risks.push('Spot GPU pricing selected - keep an on-demand/reserved floor for the minimum replica count.');
    if (input.availabilityTargetPercent >= s.haAvailabilityThreshold) {
      risks.push(`Availability ${input.availabilityTargetPercent}% needs >= 2 replicas across failure domains (and a second region or provider for API-based designs).`);
    }
    const chosenMonthly = decision === 'managed_api' ? managedApi.monthlyUsd : recommended?.monthlyTotalUsd;
    if (input.monthlyBudgetUsd !== undefined && chosenMonthly !== undefined && chosenMonthly > input.monthlyBudgetUsd) {
      risks.push(`Recommended option ${usd(chosenMonthly)}/month exceeds the ${usd(input.monthlyBudgetUsd)} budget - consider a smaller model, INT8/FP8, prompt caching, or routing easy requests to a small model.`);
    }

    const assumptions = [
      `Directional planning estimates (rules ${this.cfg.getRulesVersion()}): GPU list prices, API tier prices and model architectures come from config/inference.yaml - validate against contracts and model cards before quoting.`,
      `Serving performance uses a roofline model: ${Math.round(s.bandwidthEfficiency * 100)}% HBM bandwidth efficiency in decode, ${Math.round(s.prefillMfu * 100)}% MFU in prefill, ${Math.round(s.targetUtilization * 100)}% target utilisation, continuous batching (vLLM / TGI / TensorRT-LLM class runtime). Confirm with a load test before committing capacity.`,
      `Self-hosted monthly cost = GPU cost ${input.autoscaling ? `(autoscaled: average replicas, peak replicas for ${Math.round(p.peakHoursFraction * 100)}% of hours)` : '(provisioned for peak 24x7)'} + ${p.selfHostedOverheadPercent}% infrastructure overhead + ${usd(p.platformFixedMonthlyUsd)} platform/MLOps team.`,
      `Managed API cost uses the ${managedApi.tierLabel} list price (${usd2(managedApi.inputPer1M)} in / ${usd2(managedApi.outputPer1M)} out per 1M tokens) with no prompt-caching or batch discount.`,
      'Quality equivalence between the self-hosted model and the API tier is NOT assessed - run the customer\'s evaluation set on both before deciding.',
    ];

    return {
      rulesVersion: this.cfg.getRulesVersion(),
      demand,
      gpuOptions: options,
      recommendedGpuOption: recommended,
      managedApi,
      decision,
      decisionRationale: rationale,
      breakEven: this.breakEven(input, options),
      forecast: this.forecast(input, options),
      workings: this.workings(input, demand, recommended ?? options[0] ?? null, managedApi),
      risks,
      assumptions,
    };
  }

  // ---------------------------------------------------------------- workings
  /** Step-by-step calculation for the recommended option, with the customer's values substituted. */
  private workings(input: InferenceEngineInput, d: DemandProfile, o: GpuOption | null, api: ManagedApiCost): CalculationStep[] {
    const p = this.cfg.getPricing();
    const s = this.cfg.getSizing();
    const steps: CalculationStep[] = [
      { step: 'Average load', formula: `${fx(input.requestsPerDay, 0)} requests/day ÷ 86,400 s`, result: `${fx(d.avgRps, 2)} req/s` },
      { step: 'Peak load', formula: `${fx(d.avgRps, 2)} × ${input.peakToAverageRatio} peak-to-average`, result: `${fx(d.peakRps, 2)} req/s` },
      { step: 'Monthly tokens', formula: `${fx(input.requestsPerDay, 0)} × ${p.daysPerMonth} days × (${input.avgInputTokens} in + ${input.avgOutputTokens} out)`, result: `${fx(d.tokensPerMonth / 1e6)} M tokens` },
      {
        step: 'Managed API cost',
        formula: `${fx(d.requestsPerMonth, 0)} req × (${input.avgInputTokens} × ${usd2(api.inputPer1M)} + ${input.avgOutputTokens} × ${usd2(api.outputPer1M)}) ÷ 1M`,
        result: `${usd(api.monthlyUsd)}/month`,
      },
    ];
    if (!o) return steps;
    const precision = this.cfg.getPrecisions().find((x) => x.id === o.precision)!;
    const gpu = this.cfg.getGpus().find((g) => g.id === o.gpuId)!;
    const m = input.model;
    steps.push(
      { step: 'Model weights', formula: `${m.paramsB}B params × ${precision.bytesPerParam} bytes (${precision.label})`, result: `${fx(o.footprint.weightsGb)} GB` },
      { step: 'KV cache per token', formula: `2 × ${m.layers} layers × ${m.kvHeads} KV heads × ${m.headDim} head dim × ${precision.kvBytes} bytes`, result: `${fx(o.footprint.kvBytesPerToken / 1024, 0)} KiB` },
      {
        step: 'KV memory free per replica',
        formula: `${o.tensorParallel} GPU × (${gpu.memoryGb} GB × ${s.gpuMemoryUtilization} - ${s.runtimeOverheadGbPerGpu} GB runtime) - ${fx(o.footprint.weightsGb)} GB weights`,
        result: `${fx(o.kvCapacityGb)} GB`,
      },
      {
        step: 'Batch size',
        formula: `min(${o.maxBatchByMemory} by memory, ${o.maxBatchByTpot} by ${input.tpotTargetMs} ms TPOT, ${s.maxBatchPerReplica} cap)`,
        result: `${o.batchSize} concurrent sequences`,
      },
      {
        step: 'Time per output token',
        formula: `(active weights + ${o.batchSize} × KV read) ÷ (${o.tensorParallel} × ${gpu.bandwidthGbps} GB/s × ${s.bandwidthEfficiency} efficiency)`,
        result: `${fx(o.tpotMs)} ms (target ${input.tpotTargetMs})`,
      },
      {
        step: 'Time to first token',
        formula: `prefill of ${input.avgInputTokens} tokens × ${s.ttftContentionFactor} contention + one decode step`,
        result: `${fx(o.ttftMs, 0)} ms (target ${input.ttftTargetMs})`,
      },
      { step: 'Replica capacity', formula: `${s.targetUtilization} utilisation ÷ GPU-seconds per request (prefill + ${input.avgOutputTokens} tokens × step ÷ batch)`, result: `${fx(o.replicaCapacityRps, 2)} req/s` },
      {
        step: 'Replicas',
        formula: `max(${o.minReplicas} min for availability, ceil(${fx(d.peakRps, 2)} peak ÷ ${fx(o.replicaCapacityRps, 2)}))`,
        result: `${o.replicasAtPeak} at peak · ${o.replicasAtAverage} at average (${o.totalGpusAtPeak} GPUs at peak)`,
      },
      {
        step: 'Self-hosted cost',
        formula: `${input.autoscaling ? 'autoscaled' : 'peak'} GPU cost ${usd(input.autoscaling ? o.monthlyGpuCostAutoscaledUsd : o.monthlyGpuCostPeakUsd)} × (1 + ${p.selfHostedOverheadPercent}%) + ${usd(p.platformFixedMonthlyUsd)} platform`,
        result: `${usd(o.monthlyTotalUsd)}/month · ${usd2(o.costPerMillionTokensUsd)} per 1M tokens`,
      },
    );
    return steps;
  }
}
