import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { CapacityPlanningService } from './capacity-planning.service';
import { CapacityPlan } from './capacity-plan.entity';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { CapacityForecastEngineService } from './capacity-forecast-engine.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';

describe('CapacityPlanningService', () => {
  let service: CapacityPlanningService;
  let plansRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let indexDesignService: { getLatest: jest.Mock };
  let engine: { forecast: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };
  const assessment = {
    documentGrowthPercentPerMonth: 5,
    availableCpuCores: 16,
    availableStorageGb: 500,
    availabilityTargetPercent: 99.5,
    rpoMinutes: 60,
    rtoMinutes: 120,
  };
  const indexDesign = {
    decision: IndexType.HNSW,
    inputsUsed: { vectorCount: 1_000_000, qps: 50, dimension: 768, availableMemoryGb: 64 },
  };
  const forecastResult = {
    currentState: { vectorCount: 1_000_000, qps: 50, memoryGb: 5, storageGb: 10, cpuCores: 4 },
    forecast: [],
    shardingRecommendation: { strategy: 'test', details: [] },
    haRecommendation: [],
    drRecommendation: [],
    recommendedInfrastructure: [],
  };

  beforeEach(async () => {
    plansRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'plan-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    projectsService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1', platform: VectorPlatform.POSTGRES_PGVECTOR }),
      updatePhaseStatus: jest.fn().mockResolvedValue({}),
    };
    discoveryService = { getLatest: jest.fn().mockResolvedValue({ assessment }) };
    indexDesignService = { getLatest: jest.fn().mockResolvedValue(indexDesign) };
    engine = { forecast: jest.fn().mockReturnValue(forecastResult) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CapacityPlanningService,
        { provide: getRepositoryToken(CapacityPlan), useValue: plansRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: IndexDesignService, useValue: indexDesignService },
        { provide: CapacityForecastEngineService, useValue: engine },
      ],
    }).compile();

    service = module.get(CapacityPlanningService);
  });

  it('rejects generation before Phase 1 Discovery is complete', async () => {
    discoveryService.getLatest.mockResolvedValue(null);
    await expect(service.generatePlan('project-1', requester, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects generation before Phase 3 Index Design is complete', async () => {
    indexDesignService.getLatest.mockResolvedValue(null);
    await expect(service.generatePlan('project-1', requester, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('defaults forecast inputs from Discovery and Index Design outputs', async () => {
    await service.generatePlan('project-1', requester, {});
    expect(engine.forecast).toHaveBeenCalledWith(
      expect.objectContaining({
        currentVectorCount: 1_000_000,
        currentQps: 50,
        dimension: 768,
        availableMemoryGb: 64,
        availableCpuCores: 16,
        availableStorageGb: 500,
        monthlyGrowthPercent: 5,
        availabilityTargetPercent: 99.5,
        rpoMinutes: 60,
        rtoMinutes: 120,
      }),
    );
  });

  it('lets explicit overrides win over defaults', async () => {
    await service.generatePlan('project-1', requester, { currentVectorCount: 9_999, monthlyGrowthPercent: 25 });
    expect(engine.forecast).toHaveBeenCalledWith(expect.objectContaining({ currentVectorCount: 9_999, monthlyGrowthPercent: 25 }));
  });

  it('persists version 1 and marks the capacity phase completed', async () => {
    const plan: any = await service.generatePlan('project-1', requester, {});
    expect(plan.version).toBe(1);
    expect(plan.currentState).toEqual(forecastResult.currentState);
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
  });

  it('increments version on a second generation', async () => {
    plansRepo.count.mockResolvedValue(3);
    const plan: any = await service.generatePlan('project-1', requester, {});
    expect(plan.version).toBe(4);
  });
});
