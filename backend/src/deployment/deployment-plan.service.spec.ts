import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

// DeploymentPlanService imports VectorAdapterFactory, which imports the real
// Oracle/Milvus adapters purely for their constructor types. Both SDKs are
// globally mocked for every test via src/__mocks__/ (see the comments there) -
// no per-file jest.mock() needed here.
import { DeploymentPlanService } from './deployment-plan.service';
import { DeploymentPlan } from './deployment-plan.entity';
import { ProjectsService } from '../projects/projects.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { IacGeneratorService } from './iac-generator.service';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';

describe('DeploymentPlanService', () => {
  let service: DeploymentPlanService;
  let plansRepo: { create: jest.Mock; save: jest.Mock; count: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let projectsService: { findOne: jest.Mock; updatePhaseStatus: jest.Mock };
  let dataPipelineDesignService: { getLatest: jest.Mock };
  let indexDesignService: { getLatest: jest.Mock };
  let schemaGenerator: { generateIndexArtifact: jest.Mock };
  let iacGenerator: {
    generateTerraform: jest.Mock;
    generateKubernetesArtifacts: jest.Mock;
    getHealthCheckDefinition: jest.Mock;
    getDeploymentChecklist: jest.Mock;
    getRollbackProcedure: jest.Mock;
  };
  let adapterFactory: { getAdapter: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };
  const pipelineDesign = {
    collectionName: 'docs',
    embeddingDimension: 768,
    similarityMetric: 'cosine',
    metadataFields: [{ name: 'source', type: 'string' }],
    generatedSchemas: {
      postgres_pgvector: { ddl: 'CREATE TABLE docs (...);', notes: [] },
      oracle: { ddl: 'CREATE TABLE docs (...);', notes: [] },
      milvus: { schema: { collection_name: 'docs' }, notes: [] },
    },
  };
  const indexDesign = { decision: IndexType.HNSW, configuration: [{ name: 'M', value: 16 }] };

  beforeEach(async () => {
    plansRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'plan-1', ...data })),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    projectsService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1', name: 'My Project', platform: VectorPlatform.POSTGRES_PGVECTOR }),
      updatePhaseStatus: jest.fn().mockResolvedValue({}),
    };
    dataPipelineDesignService = { getLatest: jest.fn().mockResolvedValue(pipelineDesign) };
    indexDesignService = { getLatest: jest.fn().mockResolvedValue(indexDesign) };
    schemaGenerator = { generateIndexArtifact: jest.fn().mockReturnValue({ statement: 'CREATE INDEX ...;', notes: [] }) };
    iacGenerator = {
      generateTerraform: jest.fn().mockReturnValue('# terraform'),
      generateKubernetesArtifacts: jest.fn().mockReturnValue({ namespaceYaml: '', secretYaml: '', helmValuesYaml: '', notes: [] }),
      getHealthCheckDefinition: jest.fn().mockReturnValue({ description: 'ok', check: 'SELECT 1' }),
      getDeploymentChecklist: jest.fn().mockReturnValue(['step 1']),
      getRollbackProcedure: jest.fn().mockReturnValue(['rollback step']),
    };
    adapterFactory = { getAdapter: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeploymentPlanService,
        { provide: getRepositoryToken(DeploymentPlan), useValue: plansRepo },
        { provide: ProjectsService, useValue: projectsService },
        { provide: DataPipelineDesignService, useValue: dataPipelineDesignService },
        { provide: IndexDesignService, useValue: indexDesignService },
        { provide: SchemaGeneratorService, useValue: schemaGenerator },
        { provide: IacGeneratorService, useValue: iacGenerator },
        { provide: VectorAdapterFactory, useValue: adapterFactory },
      ],
    }).compile();

    service = module.get(DeploymentPlanService);
  });

  it('refuses to submit a plan before a platform is resolved', async () => {
    projectsService.findOne.mockResolvedValue({ id: 'project-1', name: 'My Project', platform: VectorPlatform.UNDETERMINED });
    await expect(service.submitPlan('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to submit a plan before Phase 2 is complete', async () => {
    dataPipelineDesignService.getLatest.mockResolvedValue(null);
    await expect(service.submitPlan('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to submit a plan before Phase 3 is complete', async () => {
    indexDesignService.getLatest.mockResolvedValue(null);
    await expect(service.submitPlan('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('combines the Phase 2 table DDL with the Phase 3 index DDL for a SQL platform', async () => {
    const plan: any = await service.submitPlan('project-1', requester);
    expect(plan.sqlScript).toContain('CREATE TABLE docs');
    expect(plan.sqlScript).toContain('CREATE INDEX ...');
    expect(plan.kubernetesArtifacts).toBeUndefined();
    expect(projectsService.updatePhaseStatus).toHaveBeenCalled();
  });

  it('generates Kubernetes artifacts only for Milvus', async () => {
    projectsService.findOne.mockResolvedValue({ id: 'project-1', name: 'My Project', platform: VectorPlatform.MILVUS });
    const plan: any = await service.submitPlan('project-1', requester);
    expect(iacGenerator.generateKubernetesArtifacts).toHaveBeenCalled();
    expect(plan.sqlScript).toContain('milvus has no SQL dialect');
  });

  it('execute refuses when no plan has been submitted yet', async () => {
    plansRepo.findOne.mockResolvedValue(null);
    await expect(service.executeLatestPlan('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('execute refuses and never creates schema/index when the target is unreachable', async () => {
    plansRepo.findOne.mockResolvedValue({ id: 'plan-1', version: 1 });
    const adapter = { healthCheck: jest.fn().mockResolvedValue(false), createSchema: jest.fn(), createVectorIndex: jest.fn() };
    adapterFactory.getAdapter.mockReturnValue(adapter);
    await expect(service.executeLatestPlan('project-1', requester)).rejects.toBeInstanceOf(BadRequestException);
    expect(adapter.createSchema).not.toHaveBeenCalled();
  });

  it('execute creates the schema and index once the target is healthy', async () => {
    plansRepo.findOne.mockResolvedValue({ id: 'plan-1', version: 1 });
    const adapter = { healthCheck: jest.fn().mockResolvedValue(true), createSchema: jest.fn(), createVectorIndex: jest.fn() };
    adapterFactory.getAdapter.mockReturnValue(adapter);

    const result = await service.executeLatestPlan('project-1', requester);

    expect(adapter.createSchema).toHaveBeenCalledWith({ collectionOrTableName: 'docs', dimension: 768, metric: 'cosine', metadataFields: pipelineDesign.metadataFields });
    expect(adapter.createVectorIndex).toHaveBeenCalledWith('docs', IndexType.HNSW, indexDesign.configuration, 'cosine');
    expect(result).toEqual({ healthCheckPassed: true, schemaCreated: true, indexCreated: true });
    expect(plansRepo.save).toHaveBeenCalledWith(expect.objectContaining({ executed: true }));
  });
});
