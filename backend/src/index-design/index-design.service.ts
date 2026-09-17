import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexDesign } from './index-design.entity';
import { CreateIndexDesignDto } from './dto/create-index-design.dto';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { IndexRecommendationInput } from '../index-recommendation-engine/index-recommendation.types';

@Injectable()
export class IndexDesignService {
  private readonly logger = new Logger(IndexDesignService.name);

  constructor(
    @InjectRepository(IndexDesign) private readonly designs: Repository<IndexDesign>,
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
    private readonly dataPipelineDesignService: DataPipelineDesignService,
    private readonly engine: IndexRecommendationEngineService,
  ) {}

  async submitDesign(projectId: string, requester: AuthenticatedUser, dto: CreateIndexDesignDto): Promise<IndexDesign> {
    await this.projectsService.findOne(projectId, requester);

    const input = await this.resolveInput(projectId, requester, dto);
    const result = this.engine.evaluate(input);

    const previousCount = await this.designs.count({ where: { project: { id: projectId } } });
    const version = previousCount + 1;

    const design = await this.designs.save(
      this.designs.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        rulesVersion: result.rulesVersion,
        decision: result.decision,
        label: result.label,
        rationale: result.rationale,
        configuration: result.configuration,
        impact: result.impact,
        scalingConsiderations: result.scalingConsiderations,
        options: result.options,
        alternatives: result.alternatives,
        criteriaWeights: result.criteriaWeights,
        updateFrequency: dto.updateFrequency,
        inputsUsed: input,
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.INDEX_DESIGN, PhaseStatus.COMPLETED);

    this.logger.log(
      `user=${requester.email} action=submit_index_design projectId=${projectId} version=${version} decision=${result.decision}`,
    );

    return design;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<IndexDesign | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<IndexDesign[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  private async resolveInput(
    projectId: string,
    requester: AuthenticatedUser,
    dto: CreateIndexDesignDto,
  ): Promise<IndexRecommendationInput> {
    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    if (!discoveryOutcome) {
      throw new BadRequestException('Complete the Phase 1 Discovery assessment before running Index Design.');
    }
    const pipelineDesign = await this.dataPipelineDesignService.getLatest(projectId, requester);
    const { assessment } = discoveryOutcome;

    return {
      vectorCount: dto.vectorCount ?? assessment.estimatedVectorCount,
      dimension: dto.dimension ?? pipelineDesign?.embeddingDimension ?? assessment.embeddingDimension,
      availableMemoryGb: dto.availableMemoryGb ?? assessment.availableRamGb,
      qps: dto.qps ?? Math.max(assessment.qps, assessment.peakQps),
      recallTarget: dto.recallTarget ?? assessment.recallTarget,
      targetP95LatencyMs: dto.targetP95LatencyMs ?? assessment.targetP95LatencyMs,
      topK: dto.topK ?? assessment.topK,
      updateFrequency: dto.updateFrequency,
    };
  }
}
