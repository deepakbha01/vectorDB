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

    // `dto` already carries every field `AssessmentInput` needs (plus a few Phase 1
    // fields the engine doesn't use, like documentCount) - passing it directly keeps
    // this mapping from silently dropping a field the engine actually needs, the way
    // the old field-by-field list here once did for the search-capability flags.
    const result = this.recommendationEngine.evaluate(dto);

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
        criteriaWeights: result.criteriaWeights,
        decisionStatus: result.decisionStatus,
        confidence: result.confidence,
        tiedPlatformIds: result.tiedPlatformIds,
        tieBreakStage: result.tieBreakStage,
        openValidations: result.openValidations,
        budgetFeasibility: result.budgetFeasibility,
        complianceGate: result.complianceGate,
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

  /**
   * Answers "what changes if QPS doubles / budget halves / multi-region becomes
   * mandatory?" against the latest assessment, without submitting a new version -
   * this is exploratory, not a persisted decision.
   */
  async runSensitivityAnalysis(projectId: string, requester: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, requester);
    const assessment = await this.assessments.findOne({
      where: { project: { id: projectId } },
      order: { version: 'DESC' },
    });
    if (!assessment) {
      throw new NotFoundException('No Discovery assessment has been submitted for this project yet.');
    }

    const scenarios = [
      { name: `QPS x2 (${assessment.qps * 2} sustained / ${assessment.peakQps * 2} peak)`, overrides: { qps: assessment.qps * 2, peakQps: assessment.peakQps * 2 } },
      { name: `Vector count x2 (${(assessment.estimatedVectorCount * 2).toLocaleString()})`, overrides: { estimatedVectorCount: assessment.estimatedVectorCount * 2 } },
      ...(assessment.monthlyBudgetUsd !== undefined && assessment.monthlyBudgetUsd !== null
        ? [{ name: `Budget halved ($${assessment.monthlyBudgetUsd / 2}/mo)`, overrides: { monthlyBudgetUsd: assessment.monthlyBudgetUsd / 2 } }]
        : []),
      ...(!assessment.requiresMultiRegion
        ? [{ name: 'Multi-region becomes mandatory', overrides: { requiresMultiRegion: true } }]
        : [{ name: 'Multi-region requirement dropped', overrides: { requiresMultiRegion: false } }]),
      { name: 'Recall target raised to 0.99', overrides: { recallTarget: 0.99 } },
    ];

    const baseline = this.recommendationEngine.evaluate(assessment);
    const results = this.recommendationEngine.runSensitivityAnalysis(assessment, scenarios);
    return { baselineDecision: baseline.decision, baselineDecisionStatus: baseline.decisionStatus, scenarios: results };
  }
}
