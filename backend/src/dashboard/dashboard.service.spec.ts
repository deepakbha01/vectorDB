import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { UserRole } from '../users/user.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { PhaseStatus } from '../projects/enums/project-status.enum';

describe('DashboardService', () => {
  let service: DashboardService;
  let projectsService: { findAllForUser: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };

  const owner = { id: 'user-1', email: 'owner@example.com', role: UserRole.ARCHITECT };

  beforeEach(async () => {
    projectsService = { findAllForUser: jest.fn() };
    discoveryService = { getLatest: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
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
    expect(summary.recommendations).toContain('Run the Phase 1 Discovery assessment to receive a platform recommendation.');
  });

  it('surfaces vector count, dataset size, and risks from the latest ADR', async () => {
    projectsService.findAllForUser.mockResolvedValue([
      { id: 'p1', name: 'RAG Assistant', owner, platform: VectorPlatform.POSTGRES_PGVECTOR, platformIsManualOverride: false, phaseStatuses: { discovery: PhaseStatus.COMPLETED } },
    ]);
    discoveryService.getLatest.mockResolvedValue({
      assessment: { estimatedVectorCount: 400_000, documentCount: 100_000, avgDocumentSizeKb: 50, qps: 20, targetP95LatencyMs: 150, recallTarget: 0.9 },
      adr: { risks: ['Some risk'] },
    });

    const [summary] = await service.getSummary('user-1');

    expect(summary.vectorCount).toBe(400_000);
    expect(summary.datasetSizeBytes).toBe(100_000 * 50 * 1024);
    expect(summary.targetQps).toBe(20);
    expect(summary.risks).toEqual(['Some risk']);
    expect(summary.recommendations).toEqual([]);
  });
});
