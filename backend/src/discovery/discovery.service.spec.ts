import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscoveryService } from './discovery.service';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { ProjectsService } from '../projects/projects.service';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import {
  Environment,
  DeploymentEnvironment,
  OperationalCapability,
  TenancyModel,
  QpsScope,
  DataReplicationModel,
  SimilarityMetric,
} from './enums/discovery.enum';
import { CreateDiscoveryAssessmentDto } from './dto/create-discovery-assessment.dto';

function buildDto(): CreateDiscoveryAssessmentDto {
  return {
    environment: Environment.PRODUCTION,
    documentCount: 100_000,
    documentGrowthPercentPerMonth: 5,
    avgDocumentSizeKb: 50,
    chunksPerDocument: 4,
    estimatedVectorCount: 400_000,
    embeddingDimension: 768,
    similarityMetric: SimilarityMetric.COSINE,
    qps: 10,
    peakQps: 25,
    qpsScope: QpsScope.AGGREGATE,
    concurrentUsers: 50,
    targetP95LatencyMs: 200,
    targetP99LatencyMs: 400,
    availabilityTargetPercent: 99.5,
    rpoMinutes: 60,
    rtoMinutes: 120,
    retentionDays: 365,
    requiresSimilaritySearch: true,
    requiresSemanticSearch: true,
    requiresHybridSearch: false,
    requiresMetadataFiltering: true,
    requiresFullTextSearch: false,
    topK: 10,
    recallTarget: 0.9,
    requiresReranking: false,
    ndcgTarget: undefined,
    mrrTarget: undefined,
    hasExistingOracle: false,
    hasExistingPostgres: true,
    hasExistingKubernetes: false,
    existingPlatforms: [],
    deploymentEnvironment: DeploymentEnvironment.CLOUD,
    availableCpuCores: 8,
    availableRamGb: 32,
    availableStorageGb: 500,
    hasGpu: false,
    operationalCapability: OperationalCapability.PART_TIME,
    requiresMultiRegion: false,
    dataReplicationModel: DataReplicationModel.NONE,
    regionalFailoverRequired: false,
    crossRegionReplicationRequired: false,
    tenancyModel: TenancyModel.SINGLE_TENANT,
    requiresAuthentication: true,
    requiresRbac: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    requiresKeyManagement: false,
    requiresTenantIsolation: false,
    requiresAuditLogging: false,
    containsPii: false,
  };
}

describe('DiscoveryService', () => {
  let service: DiscoveryService;
  let assessmentsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };

  beforeEach(async () => {
    assessmentsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'assessment-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    projectsService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1' }),
      updatePhaseStatus: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        { provide: getRepositoryToken(DiscoveryAssessment), useValue: assessmentsRepo },
        { provide: ProjectsService, useValue: projectsService },
      ],
    }).compile();

    service = module.get(DiscoveryService);
  });

  it('creates version 1 for the first assessment and marks Discovery complete without deciding a platform', async () => {
    const outcome = await service.submitAssessment('project-1', requester, buildDto());

    expect(assessmentsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
    expect(projectsService.updatePhaseStatus).toHaveBeenCalledWith(
      'project-1',
      requester,
      ProjectPhase.DISCOVERY,
      PhaseStatus.COMPLETED,
    );
    expect(outcome).toEqual({ assessment: expect.objectContaining({ version: 1 }) });
    expect((outcome as any).adr).toBeUndefined();
  });

  it('increments the version for a second submission on the same project', async () => {
    assessmentsRepo.count.mockResolvedValue(1);
    await service.submitAssessment('project-1', requester, buildDto());
    expect(assessmentsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));
  });

  it('returns null from getLatest when no assessment exists yet', async () => {
    assessmentsRepo.findOne.mockResolvedValue(null);
    const result = await service.getLatest('project-1', requester);
    expect(result).toBeNull();
  });
});
