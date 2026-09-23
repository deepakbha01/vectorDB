import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigService } from '@nestjs/config';
import { InferenceConfigService } from './inference-config.service';
import { InferenceEngineService } from './inference-engine.service';
import {
  GpuPricingModel,
  InferenceEngineInput,
  InferenceOpsCapability,
  InferenceWorkloadType,
  ModelSourcing,
} from './inference.types';

// Runs against the real catalogue so a broken config/inference.yaml fails the build.
const catalogue = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/inference.yaml'), 'utf8')) as Record<string, any>;

function makeEngine() {
  const cfg = new InferenceConfigService({} as ConfigService);
  cfg.setCatalogue(catalogue);
  return { cfg, engine: new InferenceEngineService(cfg) };
}

function baseInput(cfg: InferenceConfigService, overrides: Partial<InferenceEngineInput> = {}): InferenceEngineInput {
  return {
    workloadType: InferenceWorkloadType.RAG,
    modelSourcing: ModelSourcing.EVALUATE_BOTH,
    model: cfg.getModels().find((m) => m.id === 'llama-3.1-8b')!,
    precision: 'auto',
    managedApiTier: cfg.getManagedApiTiers().find((t) => t.id === 'mid')!,
    requestsPerDay: 100_000,
    peakToAverageRatio: 3,
    avgInputTokens: 2000,
    avgOutputTokens: 300,
    maxContextTokens: 8192,
    ttftTargetMs: 2000,
    tpotTargetMs: 50,
    availabilityTargetPercent: 99.5,
    gpuPricing: GpuPricingModel.ON_DEMAND,
    autoscaling: true,
    allowThirdPartyApi: true,
    containsPii: false,
    monthlyGrowthPercent: 5,
    opsCapability: InferenceOpsCapability.DEDICATED_TEAM,
    ...overrides,
  };
}

describe('InferenceEngineService', () => {
  const { cfg, engine } = makeEngine();
  const precision = (id: string) => cfg.getPrecisions().find((p) => p.id === id)!;

  describe('catalogue', () => {
    it('loads GPUs, models, precisions and API tiers with the fields the engine needs', () => {
      expect(cfg.getGpus().length).toBeGreaterThan(0);
      for (const g of cfg.getGpus()) expect(g.memoryGb * g.bandwidthGbps * g.fp16Tflops * g.hourlyUsd).toBeGreaterThan(0);
      for (const m of cfg.getModels()) {
        expect(m.activeParamsB).toBeLessThanOrEqual(m.paramsB);
        expect(m.layers * m.kvHeads * m.headDim * m.maxContextTokens).toBeGreaterThan(0);
      }
      expect(cfg.getAutoPrecisions().every((id) => cfg.getPrecisions().some((p) => p.id === id))).toBe(true);
    });
  });

  describe('footprint', () => {
    it('computes FP16 weights and the well-known 128 KiB/token KV cache for Llama 3.1 8B', () => {
      const input = baseInput(cfg);
      const fp = engine.footprint(input.model, precision('fp16'), input);
      expect(fp.weightsGb).toBeCloseTo(16.06, 2);
      expect(fp.kvBytesPerToken).toBe(2 * 32 * 8 * 128 * 2); // 131,072 bytes
      expect(fp.kvGbPerAvgSequence).toBeCloseTo((131072 * 2300) / 1e9, 6);
    });

    it('halves weights and KV cache at FP8', () => {
      const input = baseInput(cfg);
      const fp16 = engine.footprint(input.model, precision('fp16'), input);
      const fp8 = engine.footprint(input.model, precision('fp8'), input);
      expect(fp8.weightsGb).toBeCloseTo(fp16.weightsGb / 2, 6);
      expect(fp8.kvBytesPerToken).toBe(fp16.kvBytesPerToken / 2);
    });
  });

  describe('demand', () => {
    it('derives average/peak rate and monthly tokens', () => {
      const d = engine.demand(baseInput(cfg));
      expect(d.avgRps).toBeCloseTo(100_000 / 86400, 6);
      expect(d.peakRps).toBeCloseTo((3 * 100_000) / 86400, 6);
      expect(d.tokensPerMonth).toBeCloseTo(100_000 * 30.4 * 2300, 0);
    });
  });

  describe('GPU options', () => {
    it('never places a 70B FP16 model on a single 80 GB GPU', () => {
      const input = baseInput(cfg, { model: cfg.getModels().find((m) => m.id === 'llama-3.3-70b')!, precision: 'fp16', allowedGpuIds: ['h100-80'] });
      const [opt] = engine.selfHostedOptions(input, engine.demand(input));
      expect(opt.tensorParallel).toBeGreaterThanOrEqual(2);
      expect(opt.footprint.weightsGb / opt.tensorParallel).toBeLessThan(80);
    });

    it('only evaluates FP8 on GPUs with FP8 tensor cores', () => {
      const input = baseInput(cfg, { allowedGpuIds: ['a100-80', 'h100-80'] });
      const opts = engine.selfHostedOptions(input, engine.demand(input));
      expect(opts.some((o) => o.gpuId === 'a100-80' && o.precision === 'fp8')).toBe(false);
      expect(opts.some((o) => o.gpuId === 'h100-80' && o.precision === 'fp8')).toBe(true);
    });

    it('keeps the batch within KV memory and the TPOT budget, and TPOT within target when met', () => {
      const input = baseInput(cfg);
      for (const o of engine.selfHostedOptions(input, engine.demand(input))) {
        expect(o.batchSize).toBeLessThanOrEqual(Math.max(1, o.maxBatchByMemory));
        if (o.meetsTpot) expect(o.tpotMs).toBeLessThanOrEqual(input.tpotTargetMs + 1e-9);
        expect(o.replicasAtPeak).toBeGreaterThanOrEqual(o.replicasAtAverage);
      }
    });

    it('penalises tensor parallelism on PCIe-only GPUs relative to the same GPU with NVLink', () => {
      const model = cfg.getModels().find((m) => m.id === 'llama-3.3-70b')!;
      const input = baseInput(cfg, { model, precision: 'fp8', allowedGpuIds: ['l40s'] });
      const [pcie] = engine.selfHostedOptions(input, engine.demand(input));
      expect(pcie.tensorParallel).toBeGreaterThan(1);
      expect(pcie.notes.join(' ')).toMatch(/PCIe/);

      const nvlinkCfg = new InferenceConfigService({} as ConfigService);
      nvlinkCfg.setCatalogue({ ...catalogue, gpus: catalogue.gpus.map((g: any) => (g.id === 'l40s' ? { ...g, interconnect: 'nvlink' } : g)) });
      const nvlinkEngine = new InferenceEngineService(nvlinkCfg);
      // Same GPU, precision and TP degree - only the interconnect differs.
      const at = (e: InferenceEngineService, c: InferenceConfigService) =>
        (e as any).evaluateConfig(c.getGpus().find((g) => g.id === 'l40s'), precision('fp8'), 4, input, e.demand(input));
      expect(at(nvlinkEngine, nvlinkCfg).replicaCapacityRps).toBeGreaterThan(at(engine, cfg).replicaCapacityRps);
    });

    it('keeps at least 2 replicas at or above the HA availability threshold', () => {
      const input = baseInput(cfg, { availabilityTargetPercent: 99.95, requestsPerDay: 10 });
      const opts = engine.selfHostedOptions(input, engine.demand(input));
      expect(opts.every((o) => o.minReplicas === 2 && o.replicasAtPeak >= 2)).toBe(true);
    });

    it('scales replicas (and cost) with demand', () => {
      const small = baseInput(cfg, { requestsPerDay: 50_000, allowedGpuIds: ['l40s'], precision: 'fp16' });
      const big = baseInput(cfg, { requestsPerDay: 5_000_000, allowedGpuIds: ['l40s'], precision: 'fp16' });
      const [a] = engine.selfHostedOptions(small, engine.demand(small));
      const [b] = engine.selfHostedOptions(big, engine.demand(big));
      expect(b.replicasAtPeak).toBeGreaterThan(a.replicasAtPeak);
      expect(b.monthlyTotalUsd).toBeGreaterThan(a.monthlyTotalUsd);
    });

    it('prices reserved and spot capacity below on-demand', () => {
      const run = (gpuPricing: GpuPricingModel) => {
        const input = baseInput(cfg, { gpuPricing, allowedGpuIds: ['h100-80'], precision: 'fp16' });
        return engine.selfHostedOptions(input, engine.demand(input))[0].gpuHourlyUsd;
      };
      expect(run(GpuPricingModel.RESERVED_1YR)).toBeLessThan(run(GpuPricingModel.ON_DEMAND));
      expect(run(GpuPricingModel.SPOT)).toBeLessThan(run(GpuPricingModel.RESERVED_1YR));
    });
  });

  describe('managed API', () => {
    it('prices input and output tokens separately', () => {
      const input = baseInput(cfg);
      const d = engine.demand(input);
      const api = engine.managedApiCost(input, d);
      expect(api.monthlyUsd).toBeCloseTo((d.requestsPerMonth * (2000 * 3 + 300 * 15)) / 1e6, 6);
    });

    it('is excluded when data may not leave for a third-party API', () => {
      const input = baseInput(cfg, { allowThirdPartyApi: false });
      expect(engine.managedApiCost(input, engine.demand(input)).excluded).toBe(true);
    });
  });

  describe('assess', () => {
    it('recommends self-hosting when third-party APIs are not allowed and a configuration meets the SLOs', () => {
      const result = engine.assess(baseInput(cfg, { allowThirdPartyApi: false }));
      expect(result.recommendedGpuOption).not.toBeNull();
      expect(result.decision).toBe('self_hosted');
    });

    it('falls back to the managed API when no GPU meets an impossible TPOT target', () => {
      const result = engine.assess(baseInput(cfg, { tpotTargetMs: 5, allowedGpuIds: ['l4'] }));
      expect(result.recommendedGpuOption).toBeNull();
      expect(result.decision).toBe('managed_api');
    });

    it('reports none_feasible when nothing meets the SLOs and APIs are not allowed', () => {
      const result = engine.assess(baseInput(cfg, { tpotTargetMs: 5, allowedGpuIds: ['l4'], allowThirdPartyApi: false }));
      expect(result.decision).toBe('none_feasible');
    });

    it('favours the small API tier at low volume and self-hosting at very high volume', () => {
      const small = cfg.getManagedApiTiers().find((t) => t.id === 'small')!;
      expect(engine.assess(baseInput(cfg, { requestsPerDay: 2_000, managedApiTier: small })).decision).toBe('managed_api');
      expect(engine.assess(baseInput(cfg, { requestsPerDay: 20_000_000 })).decision).toBe('self_hosted');
    });

    it('finds a break-even volume where self-hosting is no more expensive than the API', () => {
      const result = engine.assess(baseInput(cfg));
      const be = result.breakEven.breakEvenRequestsPerDay;
      expect(be).not.toBeNull();
      const point = result.breakEven.curve.find((p) => p.requestsPerDay === be)!;
      expect(point.selfHostedMonthlyUsd!).toBeLessThanOrEqual(point.managedApiMonthlyUsd);
      expect(result.breakEven.curve).toHaveLength(cfg.getBreakEvenScan().points);
    });

    it('forecasts each configured horizon with compounding growth', () => {
      const result = engine.assess(baseInput(cfg, { monthlyGrowthPercent: 10 }));
      expect(result.forecast.map((f) => f.horizonMonths)).toEqual(cfg.getForecastHorizons());
      const f12 = result.forecast.find((f) => f.horizonMonths === 12)!;
      expect(f12.requestsPerDay).toBe(Math.round(100_000 * Math.pow(1.1, 12)));
      expect(f12.managedApiMonthlyUsd).toBeGreaterThan(engine.managedApiCost(baseInput(cfg), engine.demand(baseInput(cfg))).monthlyUsd);
    });

    it('flags budget, PII, ops-capability, licence and context-window risks', () => {
      const result = engine.assess(
        baseInput(cfg, {
          requestsPerDay: 20_000_000,
          monthlyBudgetUsd: 100,
          containsPii: true,
          opsCapability: InferenceOpsCapability.NONE,
          maxContextTokens: 200_000,
        }),
      );
      const text = result.risks.join(' | ');
      expect(text).toMatch(/exceeds the \$100 budget/);
      expect(text).toMatch(/MLOps/);
      expect(text).toMatch(/licence/i);
      expect(text).toMatch(/exceeds Llama 3.1 8B Instruct's 131,072/);
    });

    it('explains the recommended option step by step with the customer\'s values', () => {
      const result = engine.assess(baseInput(cfg));
      const steps = result.workings.map((w) => w.step);
      expect(steps).toEqual(expect.arrayContaining(['Peak load', 'Managed API cost', 'Model weights', 'KV cache per token', 'Batch size', 'Replicas', 'Self-hosted cost']));
      expect(result.workings.find((w) => w.step === 'Average load')!.formula).toContain('100,000');
    });
  });
});
