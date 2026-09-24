import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { VectorDbSelectionService } from '../vector-db-selection/vector-db-selection.service';
import { UserRole } from '../users/user.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { PhaseStatus } from '../projects/enums/project-status.enum';
import { CustomerMode } from '../projects/enums/customer-mode.enum';

describe('DashboardService', () => {
  let service: DashboardService;
  let projectsService: { findAllForUser: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let vectorDbSelectionService: { getLatest: jest.Mock };

  const owner = { id: 'user-1', email: 'owner@example.com', role: UserRole.ARCHITECT };

  beforeEach(async () => {
    projectsService = { findAllForUser: jest.fn() };
    discoveryService = { getLatest: jest.fn() };
    vectorDbSelectionService = { getLatest: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: VectorDbSelectionService, useValue: vectorDbSelectionService },
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
});
