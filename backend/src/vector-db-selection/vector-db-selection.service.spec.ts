import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { VectorDbSelectionService } from './vector-db-selection.service';
import { ArchitectureDecisionRecord } from './architecture-decision-record.entity';
import { DiscoveryService } from '../discovery/discovery.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectPhase } from '../projects/enums/project-status.enum';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import { VectorPlatform } from '../projects/enums/platform.enum';

describe('VectorDbSelectionService', () => {
  let service: VectorDbSelectionService;
  let adrRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let dataPipelineDesignService: { getLatest: jest.Mock };
  let indexDesignService: { getLatest: jest.Mock };
  let projectsService: { findOne: jest.Mock; applyEngineRecommendation: jest.Mock };
  let recommendationEngine: { evaluate: jest.Mock; runSensitivityAnalysis: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };
  const assessment = { id: 'assessment-1', version: 3, qps: 10, peakQps: 25, estimatedVectorCount: 400_000, requiresMultiRegion: false, monthlyBudgetUsd: 1000 };

  beforeEach(async () => {
    adrRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'adr-1', ...data })),
      findOne: jest.fn(),
    };
    discoveryService = { getLatest: jest.fn().mockResolvedValue({ assessment }) };
    dataPipelineDesignService = { getLatest: jest.fn().mockResolvedValue({ id: 'pipeline-1' }) };
    indexDesignService = { getLatest: jest.fn().mockResolvedValue({ id: 'index-design-1' }) };
    projectsService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1' }),
      applyEngineRecommendation: jest.fn().mockResolvedValue({}),
    };
    recommendationEngine = {
      evaluate: jest.fn().mockReturnValue({
        rulesVersion: '1.0.0',
        decision: VectorPlatform.POSTGRES_PGVECTOR,
        rationale: 'test rationale',
        options: [],
        rejectedAlternatives: [],
        assumptions: [],
        risks: [],
        infrastructureEstimate: { estimatedRawVectorGb: 1, estimatedMemoryGb: 1, estimatedStorageGb: 1, estimatedCpuCores: 2, notes: [] },
        operationalComplexity: 'low',
      }),
      runSensitivityAnalysis: jest.fn().mockReturnValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VectorDbSelectionService,
        { provide: getRepositoryToken(ArchitectureDecisionRecord), useValue: adrRepo },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: DataPipelineDesignService, useValue: dataPipelineDesignService },
        { provide: IndexDesignService, useValue: indexDesignService },
        { provide: ProjectsService, useValue: projectsService },
        { provide: RecommendationEngineService, useValue: recommendationEngine },
      ],
    }).compile();

    service = module.get(VectorDbSelectionService);
  });

  it('runs the engine and applies the recommendation once Phases 1-3 are complete', async () => {
    const outcome = await service.run('project-1', requester);

    expect(recommendationEngine.evaluate).toHaveBeenCalledWith(assessment);
    expect(projectsService.applyEngineRecommendation).toHaveBeenCalledWith(
      'project-1',
      requester,
      VectorPlatform.POSTGRES_PGVECTOR,
      'test rationale',
      3,
      ProjectPhase.VECTOR_DB_SELECTION,
    );
    expect(outcome.adr.decision).toBe(VectorPlatform.POSTGRES_PGVECTOR);
  });

  it('rejects when Phase 1 Discovery has not been completed', async () => {
    discoveryService.getLatest.mockResolvedValue(null);
    await expect(service.run('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
    expect(recommendationEngine.evaluate).not.toHaveBeenCalled();
  });

  it('rejects when Phase 2 Data & Embedding Design has not been completed', async () => {
    dataPipelineDesignService.getLatest.mockResolvedValue(null);
    await expect(service.run('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
    expect(recommendationEngine.evaluate).not.toHaveBeenCalled();
  });

  it('rejects when Phase 3 Index Design has not been completed', async () => {
    indexDesignService.getLatest.mockResolvedValue(null);
    await expect(service.run('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
    expect(recommendationEngine.evaluate).not.toHaveBeenCalled();
  });

  it('returns null from getLatest when Vector DB Selection has not run yet', async () => {
    adrRepo.findOne.mockResolvedValue(null);
    const result = await service.getLatest('project-1', requester);
    expect(result).toBeNull();
  });

  it('runs sensitivity analysis against the latest Discovery assessment', async () => {
    const result = await service.runSensitivityAnalysis('project-1', requester);
    expect(recommendationEngine.runSensitivityAnalysis).toHaveBeenCalled();
    expect(result.baselineDecision).toBe(VectorPlatform.POSTGRES_PGVECTOR);
  });
});
