import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { IndexDesignService } from './index-design.service';
import { IndexDesign } from './index-design.entity';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { UpdateFrequency } from '../index-recommendation-engine/enums/update-frequency.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';

describe('IndexDesignService', () => {
  let service: IndexDesignService;
  let designsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let dataPipelineDesignService: { getLatest: jest.Mock };
  let engine: { evaluate: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };

  const assessment = {
    estimatedVectorCount: 400_000,
    embeddingDimension: 768,
    qps: 20,
    peakQps: 60,
    recallTarget: 0.9,
    targetP95LatencyMs: 150,
    topK: 10,
    availableRamGb: 32,
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
    discoveryService = { getLatest: jest.fn().mockResolvedValue({ assessment }) };
    dataPipelineDesignService = { getLatest: jest.fn().mockResolvedValue(null) };
    engine = { evaluate: jest.fn().mockReturnValue(engineResult) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexDesignService,
        { provide: getRepositoryToken(IndexDesign), useValue: designsRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: DataPipelineDesignService, useValue: dataPipelineDesignService },
        { provide: IndexRecommendationEngineService, useValue: engine },
      ],
    }).compile();

    service = module.get(IndexDesignService);
  });

  it('rejects submission when no Discovery assessment exists yet', async () => {
    discoveryService.getLatest.mockResolvedValue(null);
    await expect(service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('defaults engine inputs from the latest Discovery assessment', async () => {
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

  it('prefers the Data Pipeline Design dimension over the Discovery estimate when available', async () => {
    dataPipelineDesignService.getLatest.mockResolvedValue({ embeddingDimension: 1536 });
    await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW });
    expect(engine.evaluate).toHaveBeenCalledWith(expect.objectContaining({ dimension: 1536 }));
  });

  it('lets explicit overrides win over both defaults', async () => {
    await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.HIGH, vectorCount: 999, recallTarget: 0.5 });
    expect(engine.evaluate).toHaveBeenCalledWith(expect.objectContaining({ vectorCount: 999, recallTarget: 0.5 }));
  });

  it('persists version 1 and marks the index_design phase completed', async () => {
    const design = await service.submitDesign('project-1', requester, { updateFrequency: UpdateFrequency.LOW });
    expect(designsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ version: 1, decision: IndexType.HNSW }));
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
    expect(design.decision).toBe(IndexType.HNSW);
  });
});
