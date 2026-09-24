import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project, initialPhaseStatuses } from './project.entity';
import { User, UserRole } from '../users/user.entity';
import { VectorPlatform } from './enums/platform.enum';
import { PhaseStatus, ProjectPhase } from './enums/project-status.enum';
import { CustomerMode } from './enums/customer-mode.enum';
import { AuthenticatedUser } from '../auth/auth.service';
import { PlatformConfigService } from '../common/config/platform-config.service';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  async create(
    owner: AuthenticatedUser,
    name: string,
    businessUseCase?: string,
    industry?: string,
    patternId?: string,
    customerMode: CustomerMode = CustomerMode.NEW,
  ): Promise<Project> {
    if (patternId && !this.platformConfig.getPatternCatalog().some((p) => p.id === patternId)) {
      throw new BadRequestException(`Unknown pattern '${patternId}'.`);
    }
    const project = this.projects.create({
      name,
      businessUseCase,
      industry,
      patternId,
      customerMode,
      owner: { id: owner.id } as User,
      platform: VectorPlatform.UNDETERMINED,
      phaseStatuses: initialPhaseStatuses(),
      assessmentVersion: 1,
    });
    const saved = await this.projects.save(project);
    this.logger.log(
      `user=${owner.email} action=create_project projectId=${saved.id} patternId=${patternId ?? 'none'} customerMode=${customerMode}`,
    );
    return saved;
  }

  async findAllForUser(userId: string): Promise<Project[]> {
    return this.projects.find({ where: { owner: { id: userId } }, order: { createdAt: 'DESC' } });
  }

  async findOne(id: string, requester: AuthenticatedUser): Promise<Project> {
    const project = await this.projects.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException(`Project '${id}' was not found.`);
    }
    this.assertAccess(project, requester);
    return project;
  }

  /**
   * Manual platform selection/override. Phase 4 (Vector DB Selection)'s Recommendation
   * Engine normally populates `platform` automatically; this path exists for explicit
   * user overrides and always requires a rationale for auditability.
   */
  async selectPlatform(id: string, requester: AuthenticatedUser, platform: VectorPlatform, rationale?: string): Promise<Project> {
    const project = await this.findOne(id, requester);

    if (platform !== VectorPlatform.UNDETERMINED && !rationale) {
      throw new BadRequestException(
        'A rationale is required when manually selecting or overriding the target platform.',
      );
    }

    project.platform = platform;
    project.platformIsManualOverride = true;
    project.platformDecisionRationale = rationale;
    const saved = await this.projects.save(project);

    this.logger.log(
      `user=${requester.email} action=select_platform projectId=${id} platform=${platform} manualOverride=true`,
    );
    return saved;
  }

  /**
   * Called by Phase 4 (Vector DB Selection) once the Recommendation Engine has
   * produced an Architecture Decision Record. Distinct from `selectPlatform`
   * (a manual override) so the audit trail can tell an automated decision
   * from a human one. `phase` is the calling phase to mark COMPLETED - always
   * `ProjectPhase.VECTOR_DB_SELECTION` today, but left as a parameter rather
   * than hardcoded so this method stays reusable.
   */
  async applyEngineRecommendation(
    id: string,
    requester: AuthenticatedUser,
    platform: VectorPlatform,
    rationale: string,
    assessmentVersion: number,
    phase: ProjectPhase,
  ): Promise<Project> {
    const project = await this.findOne(id, requester);
    project.platform = platform;
    project.platformIsManualOverride = false;
    project.platformDecisionRationale = rationale;
    project.assessmentVersion = assessmentVersion;
    project.phaseStatuses = { ...project.phaseStatuses, [phase]: PhaseStatus.COMPLETED };
    const saved = await this.projects.save(project);

    this.logger.log(
      `user=${requester.email} action=apply_recommendation projectId=${id} platform=${platform} assessmentVersion=${assessmentVersion}`,
    );
    return saved;
  }

  async updatePhaseStatus(id: string, requester: AuthenticatedUser, phase: ProjectPhase, status: PhaseStatus): Promise<Project> {
    const project = await this.findOne(id, requester);
    project.phaseStatuses = { ...project.phaseStatuses, [phase]: status };
    const saved = await this.projects.save(project);
    this.logger.log(`user=${requester.email} action=update_phase_status projectId=${id} phase=${phase} status=${status}`);
    return saved;
  }

  private assertAccess(project: Project, requester: AuthenticatedUser): void {
    const isOwner = project.owner?.id === requester.id;
    const isAdmin = requester.role === UserRole.ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You do not have access to this project.');
    }
  }
}
