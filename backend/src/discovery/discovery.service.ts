import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { CreateDiscoveryAssessmentDto } from './dto/create-discovery-assessment.dto';
import { ProjectsService } from '../projects/projects.service';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';

export interface DiscoveryOutcome {
  assessment: DiscoveryAssessment;
}

/**
 * Phase 1 - Discovery: AI Use Case & Workload Assessment. Captures and
 * versions the workload qualification inputs only - it does NOT run the
 * Recommendation Engine or finalize a target platform. That decision belongs
 * to Phase 4 (Vector DB Selection, see `vector-db-selection` module), which
 * reads the latest assessment produced here once Phases 1-3 are complete.
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    @InjectRepository(DiscoveryAssessment) private readonly assessments: Repository<DiscoveryAssessment>,
    private readonly projectsService: ProjectsService,
  ) {}

  async submitAssessment(
    projectId: string,
    requester: AuthenticatedUser,
    dto: CreateDiscoveryAssessmentDto,
  ): Promise<DiscoveryOutcome> {
    await this.projectsService.findOne(projectId, requester); // enforces access

    const previousCount = await this.assessments.count({ where: { project: { id: projectId } } });
    const version = previousCount + 1;

    const assessment = await this.assessments.save(
      this.assessments.create({
        ...dto,
        project: { id: projectId } as Project,
        submittedBy: { id: requester.id } as User,
        version,
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.DISCOVERY, PhaseStatus.COMPLETED);

    this.logger.log(`user=${requester.email} action=submit_discovery_assessment projectId=${projectId} version=${version}`);

    return { assessment };
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<DiscoveryOutcome | null> {
    await this.projectsService.findOne(projectId, requester); // enforces access
    const assessment = await this.assessments.findOne({
      where: { project: { id: projectId } },
      order: { version: 'DESC' },
    });
    if (!assessment) {
      return null;
    }
    return { assessment };
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<DiscoveryOutcome[]> {
    await this.projectsService.findOne(projectId, requester);
    const assessments = await this.assessments.find({
      where: { project: { id: projectId } },
      order: { version: 'DESC' },
    });
    return assessments.map((assessment) => ({ assessment }));
  }
}
