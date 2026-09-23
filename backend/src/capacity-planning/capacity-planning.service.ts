import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CapacityPlan } from './capacity-plan.entity';
import { CreateCapacityPlanDto } from './dto/create-capacity-plan.dto';
import { CapacityForecastEngineService } from './capacity-forecast-engine.service';
import { CapacityForecastInput } from './capacity-forecast.types';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { IMPLEMENTED_BEYOND_DISCOVERY, VectorPlatform } from '../projects/enums/platform.enum';

@Injectable()
export class CapacityPlanningService {
  private readonly logger = new Logger(CapacityPlanningService.name);

  constructor(
    @InjectRepository(CapacityPlan) private readonly plans: Repository<CapacityPlan>,
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
    private readonly indexDesignService: IndexDesignService,
    private readonly engine: CapacityForecastEngineService,
  ) {}

  async generatePlan(projectId: string, requester: AuthenticatedUser, dto: CreateCapacityPlanDto): Promise<CapacityPlan> {
    const project = await this.projectsService.findOne(projectId, requester);
    if (project.platform === VectorPlatform.UNDETERMINED) {
      throw new BadRequestException('Complete Phase 4 Vector DB Selection (or manually select a platform) before capacity planning.');
    }
    if (!IMPLEMENTED_BEYOND_DISCOVERY.has(project.platform)) {
      // Defensive only - every VectorPlatform value other than UNDETERMINED is currently in this set.
      throw new BadRequestException(`Capacity forecasting is not yet implemented for '${project.platform}'.`);
    }

    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    if (!discoveryOutcome) {
      throw new BadRequestException('Complete the Phase 1 Discovery assessment before capacity planning.');
    }
    const indexDesign = await this.indexDesignService.getLatest(projectId, requester);
    if (!indexDesign) {
      throw new BadRequestException('Complete Phase 3 (Index Design) before capacity planning.');
    }

    const input: CapacityForecastInput = {
      currentVectorCount: dto.currentVectorCount ?? indexDesign.inputsUsed.vectorCount,
      currentQps: dto.currentQps ?? indexDesign.inputsUsed.qps,
      dimension: indexDesign.inputsUsed.dimension,
      availableMemoryGb: dto.availableMemoryGb ?? indexDesign.inputsUsed.availableMemoryGb,
      availableCpuCores: dto.availableCpuCores ?? discoveryOutcome.assessment.availableCpuCores,
      availableStorageGb: dto.availableStorageGb ?? discoveryOutcome.assessment.availableStorageGb,
      monthlyGrowthPercent: dto.monthlyGrowthPercent ?? discoveryOutcome.assessment.documentGrowthPercentPerMonth,
      platform: project.platform,
      indexType: indexDesign.decision,
      availabilityTargetPercent: discoveryOutcome.assessment.availabilityTargetPercent,
      rpoMinutes: discoveryOutcome.assessment.rpoMinutes,
      rtoMinutes: discoveryOutcome.assessment.rtoMinutes,
    };

    const result = this.engine.forecast(input);

    const previousCount = await this.plans.count({ where: { project: { id: projectId } } });
    const plan = await this.plans.save(
      this.plans.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version: previousCount + 1,
        platform: project.platform,
        indexType: indexDesign.decision,
        inputsUsed: input,
        currentState: result.currentState,
        forecast: result.forecast,
        shardingRecommendation: result.shardingRecommendation,
        haRecommendation: result.haRecommendation,
        drRecommendation: result.drRecommendation,
        recommendedInfrastructure: result.recommendedInfrastructure,
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.CAPACITY, PhaseStatus.COMPLETED);

    this.logger.log(`user=${requester.email} action=generate_capacity_plan projectId=${projectId} version=${plan.version}`);

    return plan;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<CapacityPlan | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.plans.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<CapacityPlan[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.plans.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
