import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiFactoryService } from '../ai-factory.service';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../../features/features.controller';
import { AiFinalRecommendation, FinalProvenance } from './final.entity';
import { buildFinalRecommendation } from './final.engine';
import { FinalInputs, FinalResult } from './final.types';

/**
 * Final AI Architecture Recommendation (spec §15-§18, §25, §26). Reads the AI
 * Factory's own view of the project - lineage, central state and every
 * decision record - so it combines exactly what the other phases decided.
 */
@Injectable()
export class FinalRecommendationService {
  private readonly logger = new Logger(FinalRecommendationService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly aiFactory: AiFactoryService,
    private readonly config: ConfigService,
    @InjectRepository(AiFinalRecommendation) private readonly finals: Repository<AiFinalRecommendation>,
  ) {}

  private async inputs(projectId: string, requester: AuthenticatedUser): Promise<FinalInputs> {
    const project = await this.projectsService.findOne(projectId, requester);
    const [overview, decisions] = await Promise.all([this.aiFactory.getOverview(projectId, requester), this.aiFactory.getDecisionRecords(projectId, requester)]);
    // Token evidence joins the cost gate only where Token Observability is switched on.
    const tokenObservability = new FeaturesController(this.config).flags().tokenObservability;
    return { projectName: project.name, state: overview.state, lineage: overview.phases, decisions, tokenObservability };
  }

  async preview(projectId: string, requester: AuthenticatedUser): Promise<FinalResult> {
    return buildFinalRecommendation(await this.inputs(projectId, requester));
  }

  async submit(projectId: string, requester: AuthenticatedUser): Promise<AiFinalRecommendation> {
    const x = await this.inputs(projectId, requester);
    const result = buildFinalRecommendation(x);
    // What this version was built from, so a later reader can tell which records it reflects.
    const context: FinalProvenance = { phases: x.lineage.filter((l) => l.phase !== 'final_recommendation').map((l) => ({ phase: l.phase, version: l.latest?.version ?? null, status: l.status })) };
    const version = (await this.finals.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.finals.save(
      this.finals.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: {}, context, sources: {}, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=final_recommendation projectId=${projectId} version=${version} readiness=${result.readiness.status} confidence=${result.executiveSummary.confidence}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiFinalRecommendation | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.finals.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
