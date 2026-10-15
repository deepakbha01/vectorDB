import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { IndexDesignService } from './index-design.service';
import { IndexDesign } from './index-design.entity';
import { ProjectsService } from '../projects/projects.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { UpdateFrequency } from '../index-recommendation-engine/enums/update-frequency.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { PlatformConfigService } from '../common/config/platform-config.service';

// The real index catalogue, so the override bounds are the shipped ones.
const indexCatalog = (yaml.load(fs.readFileSync(path.join(__dirname, '../../config/indexes.yaml'), 'utf8')) as any).indexes;

describe('IndexDesignService', () => {
  let service: IndexDesignService;
  let designsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let dataPipelineDesignService: { buildPhase3Handoff: jest.Mock };
  let engine: { evaluate: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };

  const readyHandoff = {
    vectorCount: 400_000,
    dimension: 768,
    metric: 'cosine',
    availableMemoryGb: 32,
    qps: 20,
    peakQps: 60,
    recallTarget: 0.9,
    targetP95LatencyMs: 150,
    topK: 10,
    candidateK: 100,
    filterUsage: true,
    hybridSearch: false,
    reranking: false,
    candidateIndexFamilies: [IndexType.HNSW, IndexType.IVF_FLAT, IndexType.PQ],
    status: 'READY',
    statusReasons: [],
  };

  const engineResult = {
    rulesVersion: '1.0.0',
    decision: IndexType.HNSW,
    label: 'HNSW',
    rationale: 'test rationale',
    configuration: [],
    impact: { recallEstimate: 'ok', latencyEstimate: 'ok', memoryEstimateGb: 1 },
    scalingConsiderations: [],
    options: [],
    alternatives: [],
    criteriaWeights: { recall: 0.25, latency: 0.2, memory: 0.2, throughput: 0.2, updateFriendliness: 0.15 },
  };

  beforeEach(async () => {
    designsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'index-design-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    projectsService = { findOne: jest.fn().mockResolvedValue({ id: 'project-1' }), updatePhaseStatus: jest.fn().mockResolvedValue({}) };
    dataPipelineDesignService = { buildPhase3Handoff: jest.fn().mockResolvedValue(readyHandoff) };
    engine = { evaluate: jest.fn().mockReturnValue(engineResult) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexDesignService,
        { provide: getRepositoryToken(IndexDesign), useValue: designsRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DataPipelineDesignService, useValue: dataPipelineDesignService },
        { provide: IndexRecommendationEngineService, useValue: engine },
        { provide: PlatformConfigService, useValue: { getIndexCatalog: () => indexCatalog } },
      ],
    }).compile();

    service = module.get(IndexDesignService);
  });

  it('rejects submission when the Phase 2->3 handoff is BLOCKED (e.g. Phase 1/2 incomplete)', async () => {
    dataPipelineDesignService.buildPhase3Handoff.mockResolvedValue({
      ...readyHandoff,
      status: 'BLOCKED',
      statusReasons: ['Phase 1 (Discovery) has not been completed.'],
    });
    await expect(service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(engine.evaluate).not.toHaveBeenCalled();
  });

  it('defaults engine inputs from the Phase 2->3 handoff, using the higher of sustained/peak QPS', async () => {
    await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW });
    expect(engine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        vectorCount: 400_000,
        dimension: 768,
        availableMemoryGb: 32,
        qps: 60,
        recallTarget: 0.9,
        targetP95LatencyMs: 150,
        topK: 10,
        updateFrequency: UpdateFrequency.LOW,
      }),
    );
  });

  it('proceeds (READY_WITH_CONDITIONS is not blocking, only BLOCKED is)', async () => {
    dataPipelineDesignService.buildPhase3Handoff.mockResolvedValue({
      ...readyHandoff,
      status: 'READY_WITH_CONDITIONS',
      statusReasons: ['Some validation warning.'],
    });
    await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW });
    expect(engine.evaluate).toHaveBeenCalled();
  });

  it('lets explicit overrides win over the handoff', async () => {
    await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.HIGH, vectorCount: 999, recallTarget: 0.5 });
    expect(engine.evaluate).toHaveBeenCalledWith(expect.objectContaining({ vectorCount: 999, recallTarget: 0.5 }));
  });

  it('persists version 1, marks the index_design phase completed, and stores the handoff metric on inputsUsed', async () => {
    const design = await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW });
    expect(designsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ version: 1, decision: IndexType.HNSW }));
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
    expect(design.decision).toBe(IndexType.HNSW);
    expect(design.inputsUsed.metric).toBe('cosine');
    expect(design.parameterOverrides).toBeNull();
    expect(design.overrideRationale).toBeNull();
  });

  describe('tuning parameter overrides', () => {
    const hnswConfig = [
      { name: 'M', value: 24, description: 'm' },
      { name: 'efConstruction', value: 200, description: 'efc' },
      { name: 'efSearch', value: 180, description: 'efs' },
    ];
    const reason = 'Benchmark: recall 0.778 at M=24; 0.986 at M=48 / efC=400 / efSearch=400.';
    beforeEach(() => engine.evaluate.mockReturnValue({ ...engineResult, configuration: hnswConfig, scalingConsiderations: ['engine note'] }));

    it('replaces the engine values, keeps them for audit, and records the reason', async () => {
      const design = await service.submitDesign('project-1', requester, {
        updateFrequency: UpdateFrequency.LOW,
        parameterOverrides: [{ name: 'M', value: 48 }, { name: 'efConstruction', value: 400 }, { name: 'efSearch', value: 400 }],
        overrideRationale: `  ${reason}  `,
      });
      expect(design.configuration.map((c) => [c.name, c.value])).toEqual([['M', 48], ['efConstruction', 400], ['efSearch', 400]]);
      expect(design.configuration[0].description).toBe('m');
      expect(design.parameterOverrides).toEqual([
        { name: 'M', engineValue: 24, value: 48 },
        { name: 'efConstruction', engineValue: 200, value: 400 },
        { name: 'efSearch', engineValue: 180, value: 400 },
      ]);
      expect(design.overrideRationale).toBe(reason);
      expect(design.scalingConsiderations).toEqual(['engine note', expect.stringMatching(/overridden by the architect - .*re-run the Optimization benchmark/)]);
    });

    it('drops overrides equal to the engine value (no override recorded at all if none differ)', async () => {
      const design = await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW, parameterOverrides: [{ name: 'M', value: 24 }], overrideRationale: reason });
      expect(design.parameterOverrides).toBeNull();
      expect(design.overrideRationale).toBeNull();
      expect(design.configuration).toEqual(hnswConfig);
    });

    it.each([
      ['a parameter the recommended index does not have', [{ name: 'nprobe', value: 8 }], /'nprobe' is not a tuning parameter of the recommended hnsw index - use M, efConstruction, efSearch/],
      ['a value outside the catalogue bounds', [{ name: 'M', value: 128 }], /M must be between 4 and 64 \(got 128\)/],
      ['the same parameter twice', [{ name: 'M', value: 32 }, { name: 'M', value: 48 }], /'M' is overridden more than once/],
    ])('rejects %s', async (_label, parameterOverrides, message) => {
      await expect(service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW, parameterOverrides, overrideRationale: reason })).rejects.toThrow(message);
      expect(designsRepo.save).not.toHaveBeenCalled();
    });

    it('requires a reason for an override', async () => {
      await expect(service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW, parameterOverrides: [{ name: 'M', value: 48 }], overrideRationale: ' short ' })).rejects.toThrow(/Give a reason/);
    });

    it('lists the bounds per index type from config/indexes.yaml', () => {
      expect(service.getParameterBounds().hnsw.M).toMatchObject({ min: 4, max: 64, default: 16 });
    });
  });
});
