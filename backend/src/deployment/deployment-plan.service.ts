import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeploymentPlan } from './deployment-plan.entity';
import { ProjectsService } from '../projects/projects.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { IacGeneratorService } from './iac-generator.service';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { IMPLEMENTED_BEYOND_DISCOVERY, K8S_SELF_HOSTABLE_PLATFORMS, VectorPlatform } from '../projects/enums/platform.enum';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';

export interface ExecutionResult {
  healthCheckPassed: boolean;
  schemaCreated: boolean;
  indexCreated: boolean;
}

@Injectable()
export class DeploymentPlanService {
  private readonly logger = new Logger(DeploymentPlanService.name);

  constructor(
    @InjectRepository(DeploymentPlan) private readonly plans: Repository<DeploymentPlan>,
    private readonly projectsService: ProjectsService,
    private readonly dataPipelineDesignService: DataPipelineDesignService,
    private readonly indexDesignService: IndexDesignService,
    private readonly schemaGenerator: SchemaGeneratorService,
    private readonly iacGenerator: IacGeneratorService,
    private readonly adapterFactory: VectorAdapterFactory,
  ) {}

  async submitPlan(projectId: string, requester: AuthenticatedUser): Promise<DeploymentPlan> {
    const project = await this.projectsService.findOne(projectId, requester);
    if (project.platform === VectorPlatform.UNDETERMINED) {
      throw new BadRequestException('Complete Phase 1 Discovery (or manually select a platform) before Implementation.');
    }
    if (!IMPLEMENTED_BEYOND_DISCOVERY.has(project.platform)) {
      // Defensive only - every VectorPlatform value other than UNDETERMINED is currently in this set.
      throw new BadRequestException(`Deployment planning is not yet implemented for '${project.platform}'.`);
    }

    const pipelineDesign = await this.dataPipelineDesignService.getLatest(projectId, requester);
    if (!pipelineDesign) {
      throw new BadRequestException('Complete Phase 2 (Data & Embedding Design) before Implementation.');
    }
    const indexDesign = await this.indexDesignService.getLatest(projectId, requester);
    if (!indexDesign) {
      throw new BadRequestException('Complete Phase 3 (Index Design) before Implementation.');
    }

    const platform = project.platform;
    const generatedSchema = pipelineDesign.generatedSchemas[platform];
    const indexArtifact = this.schemaGenerator.generateIndexArtifact(
      platform,
      pipelineDesign.collectionName,
      indexDesign.decision,
      indexDesign.configuration,
    );

    // SQL-based platforms store `{ ddl }`; API/SDK-config-based platforms store `{ schema }` (see GeneratedSchemas).
    const sqlScript =
      'ddl' in generatedSchema
        ? [generatedSchema.ddl, '', '-- Vector index (Phase 3 decision applied):', indexArtifact.statement].join('\n')
        : [
            `// ${platform} has no SQL dialect - the schema/index below are created via its SDK/API, not a SQL script.`,
            '// Collection/index schema:',
            JSON.stringify(generatedSchema.schema, null, 2),
            '// Index config:',
            indexArtifact.statement,
          ].join('\n\n');

    const kubernetesArtifacts = K8S_SELF_HOSTABLE_PLATFORMS.includes(platform)
      ? this.iacGenerator.generateKubernetesArtifacts(platform, pipelineDesign.collectionName)
      : undefined;

    const previousCount = await this.plans.count({ where: { project: { id: projectId } } });
    const version = previousCount + 1;

    const plan = await this.plans.save(
      this.plans.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        platform,
        collectionName: pipelineDesign.collectionName,
        sqlScript,
        terraform: this.iacGenerator.generateTerraform(platform, project.name),
        kubernetesArtifacts,
        healthCheck: this.iacGenerator.getHealthCheckDefinition(platform),
        deploymentChecklist: this.iacGenerator.getDeploymentChecklist(platform),
        rollbackProcedure: this.iacGenerator.getRollbackProcedure(platform),
        executed: false,
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.INFRASTRUCTURE, PhaseStatus.COMPLETED);

    this.logger.log(`user=${requester.email} action=submit_deployment_plan projectId=${projectId} version=${version} platform=${platform}`);

    return plan;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<DeploymentPlan | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.plans.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<DeploymentPlan[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.plans.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /**
   * Actually connects to the configured TARGET_* database and creates the
   * schema + vector index for real. Never called implicitly - only ever in
   * response to an explicit request against a plan the caller has already
   * reviewed. Only additive operations are performed (health check, create
   * schema, create index) - never a drop; those remain gated behind each
   * adapter's own confirm=true requirement and are not exposed here.
   */
  async executeLatestPlan(projectId: string, requester: AuthenticatedUser): Promise<ExecutionResult> {
    const project = await this.projectsService.findOne(projectId, requester);
    const plan = await this.getLatest(projectId, requester);
    if (!plan) {
      throw new BadRequestException('No deployment plan exists for this project yet - submit one first.');
    }
    const indexDesign = await this.indexDesignService.getLatest(projectId, requester);
    const pipelineDesign = await this.dataPipelineDesignService.getLatest(projectId, requester);
    if (!indexDesign || !pipelineDesign) {
      throw new BadRequestException('Phase 2/3 outputs are missing - re-run Design before executing.');
    }

    const adapter = this.adapterFactory.getAdapter(project.platform);

    const healthCheckPassed = await adapter.healthCheck();
    if (!healthCheckPassed) {
      throw new BadRequestException(
        'Target database is not reachable. Verify TARGET_* environment variables and network connectivity, then retry.',
      );
    }

    await adapter.createSchema({
      collectionOrTableName: pipelineDesign.collectionName,
      dimension: pipelineDesign.embeddingDimension,
      metadataFields: pipelineDesign.metadataFields,
    });
    await adapter.createVectorIndex(pipelineDesign.collectionName, indexDesign.decision, indexDesign.configuration);

    plan.executed = true;
    plan.executedAt = new Date();
    await this.plans.save(plan);

    this.logger.warn(`user=${requester.email} action=execute_deployment_plan projectId=${projectId} planVersion=${plan.version} platform=${project.platform}`);

    return { healthCheckPassed: true, schemaCreated: true, indexCreated: true };
  }
}
