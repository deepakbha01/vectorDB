import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InferenceConfigService } from './inference-config.service';
import { InferenceEngineService } from './inference-engine.service';
import { InferenceService } from './inference.service';
import { CreateInferenceAssessmentDto } from './dto/create-inference-assessment.dto';
import { InferenceOpsCapability, InferenceWorkloadType, ModelSourcing } from './inference.types';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';

const catalogue = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/inference.yaml'), 'utf8')) as Record<string, any>;
const user = { id: 'u1', email: 'a@b.c', role: 'architect' } as any;

function dto(overrides: Partial<CreateInferenceAssessmentDto> = {}): CreateInferenceAssessmentDto {
  return {
    workloadType: InferenceWorkloadType.CHAT,
    modelSourcing: ModelSourcing.EVALUATE_BOTH,
    requestsPerDay: 50_000,
    peakToAverageRatio: 3,
    avgInputTokens: 1000,
    avgOutputTokens: 250,
    maxContextTokens: 8192,
    ttftTargetMs: 1500,
    tpotTargetMs: 50,
    availabilityTargetPercent: 99.9,
    modelId: 'llama-3.1-8b',
    opsCapability: InferenceOpsCapability.DEDICATED_TEAM,
    managedApiTierId: 'mid',
    allowThirdPartyApi: true,
    containsPii: false,
    ...overrides,
  };
}

function setup(opts: { discovery?: any; pipeline?: any; profile?: any } = {}) {
  const cfg = new InferenceConfigService({} as ConfigService);
  cfg.setCatalogue(catalogue);
  const saved: any[] = [];
  const repo = {
    count: jest.fn(async () => saved.length),
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => { saved.push(x); return x; }),
    findOne: jest.fn(async () => saved[saved.length - 1] ?? null),
    find: jest.fn(async () => [...saved].reverse()),
  };
  const projects = { findOne: jest.fn(async () => ({ id: 'p1', name: 'Demo' })) };
  const discovery = { getLatest: jest.fn(async () => (opts.discovery ? { assessment: opts.discovery } : null)) };
  const pipeline = { getLatest: jest.fn(async () => opts.pipeline ?? null) };
  const profiles = { findOne: jest.fn(async () => opts.profile ?? null) };
  const service = new InferenceService(repo as any, projects as any, discovery as any, pipeline as any, new InferenceEngineService(cfg), cfg, profiles as any);
  return { service, repo, projects, discovery, pipeline };
}

describe('InferenceService', () => {
  describe('resolveInput', () => {
    it('resolves catalogue ids and applies contracted API price overrides', () => {
      const { service } = setup();
      const input = service.resolveInput(dto({ apiInputPricePer1M: 1.5, apiOutputPricePer1M: 6 }));
      expect(input.model.id).toBe('llama-3.1-8b');
      expect(input.managedApiTier).toMatchObject({ id: 'mid', inputPer1M: 1.5, outputPer1M: 6 });
      expect(input.precision).toBe('auto');
      expect(input.autoscaling).toBe(true);
    });

    it('builds a custom model, defaulting active params to total params', () => {
      const { service } = setup();
      const input = service.resolveInput(
        dto({ modelId: 'custom', customModelName: 'In-house 13B', customParamsB: 13, customLayers: 40, customKvHeads: 40, customHeadDim: 128, customMaxContextTokens: 4096, maxContextTokens: 4096 }),
      );
      expect(input.model).toMatchObject({ label: 'In-house 13B', paramsB: 13, activeParamsB: 13, layers: 40 });
    });

    it.each([
      ['unknown model', { modelId: 'gpt-x' }],
      ['unknown precision', { precision: 'fp4' }],
      ['unknown API tier', { managedApiTierId: 'premium' }],
      ['unknown GPU', { allowedGpuIds: ['tpu-v5'] }],
      ['tokens above max context', { avgInputTokens: 8000, avgOutputTokens: 500, maxContextTokens: 8192 }],
    ])('rejects %s', (_label, overrides) => {
      const { service } = setup();
      expect(() => service.resolveInput(dto(overrides as Partial<CreateInferenceAssessmentDto>))).toThrow(BadRequestException);
    });
  });

  describe('submit', () => {
    it('persists a new version each time with the decision and rules version, after checking project access', async () => {
      const { service, projects } = setup();
      const v1 = await service.submit('p1', user, dto());
      const v2 = await service.submit('p1', user, dto({ requestsPerDay: 5_000_000 }));
      expect(projects.findOne).toHaveBeenCalledWith('p1', user);
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(v2.decision).toBe(v2.result.decision);
      expect(v2.rulesVersion).toBe(catalogue.rulesVersion);
      expect(v2.submitted.requestsPerDay).toBe(5_000_000);
    });
  });

  describe('getDefaults', () => {
    it('returns nothing to pre-fill when the vector track has no Discovery assessment', async () => {
      const { service } = setup();
      expect(await service.getDefaults('p1', user)).toEqual({ source: [] });
    });

    it('derives load, RAG prompt size and compliance flags from vector Discovery + Data Pipeline', async () => {
      const { service } = setup({
        discovery: { version: 2, qps: 10, peakQps: 40, topK: 5, availabilityTargetPercent: 99.9, containsPii: true, dataResidencyRequirement: 'EU', monthlyBudgetUsd: 20000 },
        pipeline: { version: 1, chunkingStrategy: ChunkingStrategy.RECURSIVE, chunkSize: 2000 },
      });
      const s = await service.getDefaults('p1', user);
      expect(s).toMatchObject({
        workloadType: InferenceWorkloadType.RAG,
        requestsPerDay: 864_000,
        peakToAverageRatio: 4,
        ragContextTokens: 5 * 500, // 2000 chars ÷ 4 chars/token
        avgInputTokens: 2500 + catalogue.sizing.ragPromptOverheadTokens,
        availabilityTargetPercent: 99.9,
        containsPii: true,
        dataResidencyRequirement: 'EU',
        monthlyBudgetUsd: 20000,
      });
      expect(s.source).toHaveLength(2);
    });

    it('lets the AI Workload Profile override Discovery-derived values and blocks APIs for on-premises-only', async () => {
      const value = <T>(v: T) => ({ value: v, source: 'profile' });
      const { service } = setup({
        discovery: { version: 2, qps: 10, peakQps: 40, topK: 0, availabilityTargetPercent: 99.5, containsPii: false },
        profile: {
          version: 3,
          inputs: {
            dailyRequests: value(250_000),
            targetTtftMs: value(800),
            availabilityTargetPercent: value(99.95),
            containsPii: value(true),
            dataResidencyRequirement: value('EU'),
            deploymentTargets: value(['on_premises']),
          },
          result: { architecture: { class: 'agent' } },
        },
      });
      const s = await service.getDefaults('p1', user);
      expect(s).toMatchObject({
        requestsPerDay: 250_000, // profile beats qps × 86,400 (864,000)
        ttftTargetMs: 800,
        availabilityTargetPercent: 99.95,
        containsPii: true,
        dataResidencyRequirement: 'EU',
        workloadType: InferenceWorkloadType.AGENT,
        allowThirdPartyApi: false,
      });
      expect(s.source).toEqual(['Vector Discovery assessment v2', 'AI Workload Profile v3']);
    });

    it('does not block third-party APIs when a cloud target is allowed', async () => {
      const value = <T>(v: T) => ({ value: v, source: 'profile' });
      const blank = { value: null, source: 'missing' };
      const { service } = setup({
        profile: {
          version: 1,
          inputs: { dailyRequests: blank, targetTtftMs: blank, availabilityTargetPercent: blank, containsPii: blank, dataResidencyRequirement: blank, deploymentTargets: value(['on_premises', 'azure']) },
          result: { architecture: { class: 'hybrid' } },
        },
      });
      const s = await service.getDefaults('p1', user);
      expect(s.allowThirdPartyApi).toBeUndefined();
      expect(s.workloadType).toBeUndefined();
    });

    it('uses token-based chunk sizes as-is', async () => {
      const { service } = setup({
        discovery: { version: 1, qps: 1, peakQps: 1, topK: 4, availabilityTargetPercent: 99, containsPii: false },
        pipeline: { version: 1, chunkingStrategy: ChunkingStrategy.TOKEN_BASED, chunkSize: 300 },
      });
      expect((await service.getDefaults('p1', user)).ragContextTokens).toBe(1200);
    });
  });
});
