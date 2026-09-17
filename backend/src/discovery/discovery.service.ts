import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { ArchitectureDecisionRecord } from './architecture-decision-record.entity';
import { CreateDiscoveryAssessmentDto } from './dto/create-discovery-assessment.dto';
import { ProjectsService } from '../projects/projects.service';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';

export interface DiscoveryOutcome {
  assessment: DiscoveryAssessment;
  adr: ArchitectureDecisionRecord;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    @InjectRepository(DiscoveryAssessment) private readonly assessments: Repository<DiscoveryAssessment>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    private readonly projectsService: ProjectsService,
    private readonly recommendationEngine: RecommendationEngineService,
  ) {}

  async submitAssessment(
    projectId: string,
    requester: AuthenticatedUser,
    dto: CreateDiscoveryAssessmentDto,
  ): Promise<DiscoveryOutcome> {
    const project = await this.projectsService.findOne(projectId, requester);

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

    const result = this.recommendationEngine.evaluate({
      estimatedVectorCount: dto.estimatedVectorCount,
      embeddingDimension: dto.embeddingDimension,
      qps: dto.qps,
      peakQps: dto.peakQps,
      targetP95LatencyMs: dto.targetP95LatencyMs,
      recallTarget: dto.recallTarget,
      hasExistingOracle: dto.hasExistingOracle,
      hasExistingPostgres: dto.hasExistingPostgres,
      hasExistingKubernetes: dto.hasExistingKubernetes,
      containsPii: dto.containsPii,
    });

    const adr = await this.adrs.save(
      this.adrs.create({
        project: { id: projectId } as Project,
        assessment,
        rulesVersion: result.rulesVersion,
        decision: result.decision,
        rationale: result.rationale,
        options: result.options,
        rejectedAlternatives: result.rejectedAlternatives,
        assumptions: result.assumptions,
        risks: result.risks,
        infrastructureEstimate: result.infrastructureEstimate,
        operationalComplexity: result.operationalComplexity,
        plainLanguageSummary: result.plainLanguageSummary,
      }),
    );

    await this.projectsService.applyEngineRecommendation(projectId, requester, result.decision, result.rationale, version);

    this.logger.log(
      `user=${requester.email} action=submit_discovery_assessment projectId=${projectId} version=${version} decision=${result.decision}`,
    );

    return { assessment, adr };
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
    const adr = await this.adrs.findOne({ where: { assessment: { id: assessment.id } } });
    if (!adr) {
      throw new NotFoundException(`Architecture Decision Record missing for assessment '${assessment.id}'.`);
    }
    return { assessment, adr };
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<DiscoveryOutcome[]> {
    await this.projectsService.findOne(projectId, requester);
    const assessments = await this.assessments.find({
      where: { project: { id: projectId } },
      order: { version: 'DESC' },
    });

    const outcomes: DiscoveryOutcome[] = [];
    for (const assessment of assessments) {
      const adr = await this.adrs.findOne({ where: { assessment: { id: assessment.id } } });
      if (adr) {
        outcomes.push({ assessment, adr });
      }
    }
    return outcomes;
  }
}
