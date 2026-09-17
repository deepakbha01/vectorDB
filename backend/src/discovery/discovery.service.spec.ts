import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscoveryService } from './discovery.service';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { ArchitectureDecisionRecord } from './architecture-decision-record.entity';
import { ProjectsService } from '../projects/projects.service';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { Environment, DeploymentEnvironment, OperationalCapability, TenancyModel } from './enums/discovery.enum';
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
    qps: 10,
    peakQps: 25,
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
    tenancyModel: TenancyModel.SINGLE_TENANT,
    requiresAuthentication: true,
    requiresRbac: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    containsPii: false,
  };
}

describe('DiscoveryService', () => {
  let service: DiscoveryService;
  let assessmentsRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let adrRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let projectsService: { findOne: jest.Mock; applyEngineRecommendation: jest.Mock };
  let recommendationEngine: { evaluate: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };

  beforeEach(async () => {
    assessmentsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'assessment-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    adrRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'adr-1', ...data })),
      findOne: jest.fn(),
    };
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
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        { provide: getRepositoryToken(DiscoveryAssessment), useValue: assessmentsRepo },
        { provide: getRepositoryToken(ArchitectureDecisionRecord), useValue: adrRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: RecommendationEngineService, useValue: recommendationEngine },
      ],
    }).compile();

    service = module.get(DiscoveryService);
  });

  it('creates version 1 for the first assessment and applies the recommendation to the project', async () => {
    const outcome = await service.submitAssessment('project-1', requester, buildDto());

    expect(assessmentsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
    expect(recommendationEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedVectorCount: 400_000, hasExistingPostgres: true }),
    );
    expect(projectsService.applyEngineRecommendation).toHaveBeenCalledWith(
      'project-1',
      requester,
      VectorPlatform.POSTGRES_PGVECTOR,
      'test rationale',
      1,
    );
    expect(outcome.adr.decision).toBe(VectorPlatform.POSTGRES_PGVECTOR);
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
