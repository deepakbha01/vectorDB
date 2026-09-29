import { Test, TestingModule } from '@nestjs/testing';
import { capacityUtilization, DashboardService } from './dashboard.service';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { VectorDbSelectionService } from '../vector-db-selection/vector-db-selection.service';
import { BenchmarkService } from '../benchmark/benchmark.service';
import { CapacityPlanningService } from '../capacity-planning/capacity-planning.service';
import { UserRole } from '../users/user.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { PhaseStatus } from '../projects/enums/project-status.enum';
import { CustomerMode } from '../projects/enums/customer-mode.enum';

describe('DashboardService', () => {
  let service: DashboardService;
  let projectsService: { findAllForUser: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let vectorDbSelectionService: { getLatest: jest.Mock };
  let benchmarkService: { getLatest: jest.Mock };
  let capacityPlanningService: { getLatest: jest.Mock };

  const owner = { id: 'user-1', email: 'owner@example.com', role: UserRole.ARCHITECT };

  beforeEach(async () => {
    projectsService = { findAllForUser: jest.fn() };
    discoveryService = { getLatest: jest.fn() };
    vectorDbSelectionService = { getLatest: jest.fn().mockResolvedValue(null) };
    benchmarkService = { getLatest: jest.fn().mockResolvedValue(null) };
    capacityPlanningService = { getLatest: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: VectorDbSelectionService, useValue: vectorDbSelectionService },
        { provide: BenchmarkService, useValue: benchmarkService },
        { provide: CapacityPlanningService, useValue: capacityPlanningService },
      ],
    }).compile();

    service = module.get(DashboardService);
  });

  it('prompts for a Discovery assessment when no assessment has been submitted', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.UNDETERMINED, platformIsManualOverride: false, phaseStatuses: { discovery: PhaseStatus.NOT_STARTED } },
    ]);
    discoveryService.getLatest.mockResolvedValue(null);

    const [summary] = await service.getSummary('user-1');

    expect(summary.vectorCount).toBeNull();
    expect(summary.recommendations).toContain('Complete the Phase 1 Discovery assessment.');
  });

  it('prompts for Phase 4 Vector DB Selection once Discovery is done but the platform is still undetermined', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.UNDETERMINED, platformIsManualOverride: false, phaseStatuses: { discovery: PhaseStatus.COMPLETED } },
    ]);
    discoveryService.getLatest.mockResolvedValue({
      assessment: { estimatedVectorCount: 400_000, documentCount: 100_000, avgDocumentSizeKb: 50, qps: 20, targetP95LatencyMs: 150, recallTarget: 0.9 },
    });

    const [summary] = await service.getSummary('user-1');

    expect(summary.vectorCount).toBe(400_000);
    expect(summary.recommendations).toContain('Run Phase 4 Vector DB Selection to receive a platform recommendation.');
  });

  it('surfaces vector count, dataset size, and risks from the latest ADR once Vector DB Selection has run', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.POSTGRES_PGVECTOR, platformIsManualOverride: false, customerMode: CustomerMode.EXISTING, phaseStatuses: { discovery: PhaseStatus.COMPLETED } },
    ]);
    discoveryService.getLatest.mockResolvedValue({
      assessment: { estimatedVectorCount: 400_000, documentCount: 100_000, avgDocumentSizeKb: 50, qps: 20, targetP95LatencyMs: 150, recallTarget: 0.9 },
    });
    vectorDbSelectionService.getLatest.mockResolvedValue({ adr: { risks: [{ id: 'risk-1', description: 'Some risk' }] } });

    const [summary] = await service.getSummary('user-1');

    expect(summary.vectorCount).toBe(400_000);
    expect(summary.datasetSizeBytes).toBe(100_000 * 50 * 1024);
    expect(summary.targetQps).toBe(20);
    expect(summary.risks).toEqual(['Some risk']);
    expect(summary.recommendations).toEqual([]);
    expect(summary.customerMode).toBe(CustomerMode.EXISTING);
  });

  it('leaves measured values and utilization empty until Optimization and Capacity have run', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.UNDETERMINED, platformIsManualOverride: false, phaseStatuses: { discovery: PhaseStatus.COMPLETED } },
    ]);
    discoveryService.getLatest.mockResolvedValue(null);

    const [summary] = await service.getSummary('user-1');

    expect(summary).toMatchObject({ measuredP95LatencyMs: null, measuredRecallAtK: null, capacityUtilizationPercent: null, capacityUtilizationResource: null });
  });

  it('shows the measured P95 and recall from the latest Optimization and utilization from the latest Capacity Plan', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.POSTGRES_PGVECTOR, platformIsManualOverride: false, phaseStatuses: { discovery: PhaseStatus.COMPLETED } },
    ]);
    discoveryService.getLatest.mockResolvedValue(null);
    benchmarkService.getLatest.mockResolvedValue({ recommendedVariant: { p95LatencyMs: 37, avgRecall: 1 } });
    capacityPlanningService.getLatest.mockResolvedValue({
      currentState: { memoryGb: 6, cpuCores: 2, storageGb: 10 },
      inputsUsed: { availableMemoryGb: 16, availableCpuCores: 8, availableStorageGb: 500 },
    });

    const [summary] = await service.getSummary('user-1');

    expect(benchmarkService.getLatest).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'user-1' }));
    expect(summary.measuredP95LatencyMs).toBe(37);
    expect(summary.measuredRecallAtK).toBe(1);
    // memory 6/16 = 37.5% is the busiest (CPU 25%, storage 2%)
    expect(summary.capacityUtilizationPercent).toBe(37.5);
    expect(summary.capacityUtilizationResource).toBe('memory');
    expect(summary.benchmarkNotRepresentative).toBe(false);
  });

  it('shows no measured values from an exact-scan benchmark (no pgvector on the target) and says why', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.POSTGRES_PGVECTOR, platformIsManualOverride: false, phaseStatuses: { discovery: PhaseStatus.COMPLETED } },
    ]);
    discoveryService.getLatest.mockResolvedValue(null);
    benchmarkService.getLatest.mockResolvedValue({ searchMode: 'exact_scan', recommendedVariant: { p95LatencyMs: 37, avgRecall: 1 } });

    const [summary] = await service.getSummary('user-1');

    expect(summary).toMatchObject({ measuredP95LatencyMs: null, measuredRecallAtK: null, benchmarkNotRepresentative: true });
  });
});

describe('capacityUtilization', () => {
  const plan = (current: object, available: object): any => ({ currentState: current, inputsUsed: available });

  it('reports the busiest resource as required / available, to one decimal', () => {
    expect(capacityUtilization(plan({ memoryGb: 1, cpuCores: 3, storageGb: 1 }, { availableMemoryGb: 8, availableCpuCores: 7, availableStorageGb: 100 }))).toEqual({ resource: 'cpu', percent: 42.9 });
  });

  it('can exceed 100% when the requirement is already above what is available', () => {
    expect(capacityUtilization(plan({ memoryGb: 24, cpuCores: 1, storageGb: 1 }, { availableMemoryGb: 16, availableCpuCores: 8, availableStorageGb: 100 }))).toEqual({ resource: 'memory', percent: 150 });
  });

  it('skips resources with no available capacity, and gives null when none is recorded', () => {
    expect(capacityUtilization(plan({ memoryGb: 4, cpuCores: 9, storageGb: 50 }, { availableMemoryGb: 8, availableCpuCores: 0, availableStorageGb: 0 }))).toEqual({ resource: 'memory', percent: 50 });
    expect(capacityUtilization(plan({ memoryGb: 4, cpuCores: 1, storageGb: 1 }, { availableMemoryGb: 0, availableCpuCores: 0, availableStorageGb: 0 }))).toBeNull();
  });
});
