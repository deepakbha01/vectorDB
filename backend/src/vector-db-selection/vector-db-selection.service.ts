import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArchitectureDecisionRecord } from './architecture-decision-record.entity';
import { DiscoveryService } from '../discovery/discovery.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectPhase } from '../projects/enums/project-status.enum';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { Project } from '../projects/project.entity';

export interface VectorDbSelectionOutcome {
  adr: ArchitectureDecisionRecord;
}

/**
 * Phase 4 - Vector DB Selection & Target Architecture. Runs the Recommendation
 * Engine against the latest Discovery assessment once Phases 1-3 are complete,
 * and is the only place that finalizes `project.platform` automatically
 * (a human can still override it via `ProjectsService.selectPlatform`).
 */
@Injectable()
export class VectorDbSelectionService {
  private readonly logger = new Logger(VectorDbSelectionService.name);

  constructor(
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    private readonly discoveryService: DiscoveryService,
    private readonly dataPipelineDesignService: DataPipelineDesignService,
    private readonly indexDesignService: IndexDesignService,
    private readonly projectsService: ProjectsService,
    private readonly recommendationEngine: RecommendationEngineService,
  ) {}

  async run(projectId: string, requester: AuthenticatedUser): Promise<VectorDbSelectionOutcome> {
    await this.projectsService.findOne(projectId, requester); // enforces access

    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    if (!discoveryOutcome) {
      throw new BadRequestException('Complete the Phase 1 Discovery assessment before running Vector DB Selection.');
    }
    const dataPipelineDesign = await this.dataPipelineDesignService.getLatest(projectId, requester);
    if (!dataPipelineDesign) {
      throw new BadRequestException('Complete Phase 2 (Data & Embedding Design) before running Vector DB Selection.');
    }
    const indexDesign = await this.indexDesignService.getLatest(projectId, requester);
    if (!indexDesign) {
      throw new BadRequestException('Complete Phase 3 (Index Design) before running Vector DB Selection.');
    }

    const { assessment } = discoveryOutcome;
    const result = this.recommendationEngine.evaluate(assessment);

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

    await this.projectsService.applyEngineRecommendation(
      projectId,
      requester,
      result.decision,
      result.rationale,
      assessment.version,
      ProjectPhase.VECTOR_DB_SELECTION,
    );

    this.logger.log(
      `user=${requester.email} action=run_vector_db_selection projectId=${projectId} assessmentVersion=${assessment.version} decision=${result.decision}`,
    );

    return { adr };
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<VectorDbSelectionOutcome | null> {
    await this.projectsService.findOne(projectId, requester);
    const adr = await this.adrs.findOne({ where: { project: { id: projectId } }, order: { createdAt: 'DESC' } });
    if (!adr) {
      return null;
    }
    return { adr };
  }

  /**
   * Answers "what changes if QPS doubles / budget halves / multi-region becomes
   * mandatory?" against the latest Discovery assessment, without persisting a new
   * ADR - this is exploratory, not a decision.
   */
  async runSensitivityAnalysis(projectId: string, requester: AuthenticatedUser) {
    const discoveryOutcome = await this.discoveryService.getLatest(projectId, requester);
    if (!discoveryOutcome) {
      throw new NotFoundException('No Discovery assessment has been submitted for this project yet.');
    }
    const { assessment } = discoveryOutcome;

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
