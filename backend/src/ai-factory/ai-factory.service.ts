import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ProjectsService } from '../projects/projects.service';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { AuthenticatedUser } from '../auth/auth.service';
import { DiscoveryAssessment } from '../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../data-pipeline/data-pipeline-design.entity';
import { IndexDesign } from '../index-design/index-design.entity';
import { ArchitectureDecisionRecord } from '../vector-db-selection/architecture-decision-record.entity';
import { DeploymentPlan } from '../deployment/deployment-plan.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { CapacityPlan } from '../capacity-planning/capacity-plan.entity';
import { InferenceAssessment } from '../inference/inference-assessment.entity';
import { AiFactoryConfigService } from './ai-factory-config.service';
import { AiFactoryStateSnapshot } from './ai-factory-state-snapshot.entity';
import { AiWorkloadProfile } from './workload-profile/workload-profile.entity';
import { AiModelSelection } from './model-selection/model-selection.entity';
import { AiInferenceArchitecture } from './inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from './infrastructure/infrastructure.entity';
import { AiRagAgentDesign } from './rag-agent/rag-agent.entity';
import { AiSecurityAssessment } from './security/security.entity';
import { AiPerformanceAssessment } from './performance/performance.entity';
import { AiFinopsAssessment } from './finops/finops.entity';
import { AiOperationsModel } from './operations/operations.entity';
import { AiFinalRecommendation } from './final/final.entity';
import { AiTokenEstimate } from './token-observability/token-estimate.entity';
import { TokenObservabilityState } from './token-observability/token-observability.types';
import { UsageService } from './token-observability/usage.service';
import { AlertService } from './token-observability/alert.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { EmbeddingModelFacts } from './eligibility/eligibility.rules';
import { computeLineage } from './lineage.engine';
import { analyseImpact } from './impact.engine';
import { fromDataPipelineDesign, fromIndexDesign, fromInferenceArchitecture, fromInferenceAssessment, fromInfrastructureDesign, fromRagAgentDesign, fromSecurityAssessment, fromPerformanceAssessment, fromFinopsAssessment, fromOperationsModel, fromModelSelection, fromVectorDbSelection } from './decision-record.adapters';
import {
  AiFactoryOverview,
  AssessmentState,
  DecisionRecord,
  DeliverableVersion,
  ImpactAnalysis,
  PhaseKey,
  PhaseLineage,
  SnapshotComparison,
  StateSection,
  StepState,
  StepStatus,
} from './ai-factory.types';

type Versioned = { id: string; createdAt: Date; version?: number };

/**
 * AI Factory read model. Reads the existing phase deliverables (never writes
 * them) and derives lineage, staleness, impact, standard decision records and
 * the central assessment state. The only table it writes is its own
 * snapshot table.
 */
@Injectable()
export class AiFactoryService {
  private readonly logger = new Logger(AiFactoryService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(DataPipelineDesign) private readonly pipelines: Repository<DataPipelineDesign>,
    @InjectRepository(IndexDesign) private readonly indexDesigns: Repository<IndexDesign>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(DeploymentPlan) private readonly deployments: Repository<DeploymentPlan>,
    @InjectRepository(OptimizationReport) private readonly optimizations: Repository<OptimizationReport>,
    @InjectRepository(CapacityPlan) private readonly capacity: Repository<CapacityPlan>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiFactoryStateSnapshot) private readonly snapshots: Repository<AiFactoryStateSnapshot>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(AiModelSelection) private readonly modelSelections: Repository<AiModelSelection>,
    @InjectRepository(AiInferenceArchitecture) private readonly inferenceArchitectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(AiInfrastructureDesign) private readonly infrastructureDesigns: Repository<AiInfrastructureDesign>,
    @InjectRepository(AiRagAgentDesign) private readonly ragAgentDesigns: Repository<AiRagAgentDesign>,
    @InjectRepository(AiSecurityAssessment) private readonly securityAssessments: Repository<AiSecurityAssessment>,
    @InjectRepository(AiPerformanceAssessment) private readonly performanceAssessments: Repository<AiPerformanceAssessment>,
    @InjectRepository(AiFinopsAssessment) private readonly finopsAssessments: Repository<AiFinopsAssessment>,
    @InjectRepository(AiOperationsModel) private readonly operationsModels: Repository<AiOperationsModel>,
    @InjectRepository(AiFinalRecommendation) private readonly finalRecommendations: Repository<AiFinalRecommendation>,
    @InjectRepository(AiTokenEstimate) private readonly tokenEstimates: Repository<AiTokenEstimate>,
    private readonly platformConfig: PlatformConfigService,
    private readonly usage: UsageService,
    private readonly tokenAlerts: AlertService,
  ) {}

  // ---------------------------------------------------------------- loading
  private repoFor(phase: PhaseKey): Repository<any> {
    return {
      discovery: this.discovery,
      data_embeddings: this.pipelines,
      index_design: this.indexDesigns,
      vector_db_selection: this.adrs,
      infrastructure: this.deployments,
      optimization: this.optimizations,
      capacity: this.capacity,
      inference: this.inference,
      workload_profile: this.profiles,
      model_selection: this.modelSelections,
      inference_architecture: this.inferenceArchitectures,
      infrastructure_design: this.infrastructureDesigns,
      rag_agent_architecture: this.ragAgentDesigns,
      security_governance: this.securityAssessments,
      performance_benchmark: this.performanceAssessments,
      finops: this.finopsAssessments,
      operations_model: this.operationsModels,
      final_recommendation: this.finalRecommendations,
      token_observability: this.tokenEstimates,
    }[phase];
  }

  /** id/version/createdAt only. ADRs have no version column, so theirs is their position in creation order. */
  private async history(phase: PhaseKey, projectId: string): Promise<DeliverableVersion[]> {
    const repo = this.repoFor(phase);
    const hasVersion = repo.metadata.columns.some((c) => c.propertyName === 'version');
    const rows: Versioned[] = await repo.find({
      where: { project: { id: projectId } } as FindOptionsWhere<any>,
      select: hasVersion ? { id: true, version: true, createdAt: true } : { id: true, createdAt: true },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r, i) => ({ id: r.id, version: hasVersion ? r.version! : i + 1, createdAt: r.createdAt }));
  }

  private async latest<T>(phase: PhaseKey, projectId: string): Promise<T | null> {
    return this.repoFor(phase).findOne({ where: { project: { id: projectId } } as FindOptionsWhere<any>, order: { createdAt: 'DESC' } }) as Promise<T | null>;
  }

  async getLineage(projectId: string): Promise<PhaseLineage[]> {
    const phases = this.cfg.getPhases();
    const histories = Object.fromEntries(await Promise.all(phases.map(async (p) => [p.key, await this.history(p.key, projectId)] as const)));
    const lineage = computeLineage(phases, histories);
    await this.attachChangedDiscoveryFields(projectId, lineage);
    return lineage;
  }

  /** For phases whose Discovery input moved on, list which relevant answers changed since they were built. */
  private async attachChangedDiscoveryFields(projectId: string, lineage: PhaseLineage[]) {
    const latestDiscovery = lineage.find((l) => l.phase === 'discovery')?.latest;
    if (!latestDiscovery) return;
    const cache = new Map<number, ImpactAnalysis>();
    for (const l of lineage) {
      if (l.phase === 'discovery' || !l.latest) continue;
      const builtFrom = this.discoveryVersionBehind(l, lineage);
      if (builtFrom === null || builtFrom === latestDiscovery.version) continue;
      if (!cache.has(builtFrom)) cache.set(builtFrom, await this.analyseImpactBetween(projectId, builtFrom, latestDiscovery.version));
      const impact = cache.get(builtFrom)!;
      // A phase cares about a changed answer if it reads it, or is built (through hard edges) from a phase that does.
      l.changedDiscoveryFields = impact.changes
        .filter((c) => c.directPhases.includes(l.phase) || this.dependsTransitively(l.phase, c.directPhases))
        .map((c) => c.field);
    }
  }

  /** The Discovery version a phase effectively used: directly, or through the upstream it was built from. */
  private discoveryVersionBehind(l: PhaseLineage, lineage: PhaseLineage[]): number | null {
    const direct = l.upstream.find((u) => u.phase === 'discovery');
    if (direct) return direct.builtFromVersion;
    for (const u of l.upstream) {
      const up = lineage.find((x) => x.phase === u.phase);
      if (up) {
        const v = this.discoveryVersionBehind(up, lineage);
        if (v !== null) return v;
      }
    }
    return null;
  }

  private dependsTransitively(phase: PhaseKey, targets: PhaseKey[]): boolean {
    const def = this.cfg.getPhase(phase);
    return !!def?.dependsOn.some((d) => d.kind === 'hard' && (targets.includes(d.phase) || this.dependsTransitively(d.phase, targets)));
  }

  // ----------------------------------------------------------------- impact
  async getImpact(projectId: string, requester: AuthenticatedUser, from?: number, to?: number): Promise<ImpactAnalysis> {
    await this.projectsService.findOne(projectId, requester);
    const versions = await this.history('discovery', projectId);
    if (!versions.length) throw new NotFoundException('No Discovery assessment has been submitted for this project yet.');
    const toV = to ?? versions[versions.length - 1].version;
    const fromV = from ?? (versions.length > 1 ? versions[versions.length - 2].version : toV);
    return this.analyseImpactBetween(projectId, fromV, toV);
  }

  private async analyseImpactBetween(projectId: string, fromV: number, toV: number): Promise<ImpactAnalysis> {
    const load = async (v: number) => {
      const row = await this.discovery.findOne({ where: { project: { id: projectId }, version: v } });
      if (!row) throw new BadRequestException(`Discovery assessment v${v} does not exist for this project.`);
      return { version: v, values: row as unknown as Record<string, unknown> };
    };
    return analyseImpact(this.cfg.getPhases(), this.cfg.getParameterImpact(), await load(fromV), await load(toV));
  }

  // -------------------------------------------------------- decision records
  async getDecisionRecords(projectId: string, requester: AuthenticatedUser): Promise<DecisionRecord[]> {
    await this.projectsService.findOne(projectId, requester);
    const records: DecisionRecord[] = [];

    const margin = this.cfg.getModelCatalogue().confidenceMargin ?? 0.05;
    const [pipeline, profile, modelSelection] = await Promise.all([
      this.latest<DataPipelineDesign>('data_embeddings', projectId),
      this.latest<AiWorkloadProfile>('workload_profile', projectId),
      this.latest<AiModelSelection>('model_selection', projectId),
    ]);

    if (pipeline) records.push(fromDataPipelineDesign(pipeline, this.embeddingCatalogue(), this.embeddingContext(pipeline, profile, modelSelection), this.cfg.getEmbeddingEligibilityRules(), margin));

    const index = await this.latest<IndexDesign>('index_design', projectId);
    if (index) records.push(fromIndexDesign(index, await this.latest<OptimizationReport>('optimization', projectId), this.cfg.getIndexEligibilityRules(), margin));

    const adr = await this.latest<ArchitectureDecisionRecord>('vector_db_selection', projectId);
    if (adr) records.push(fromVectorDbSelection(adr, (await this.history('vector_db_selection', projectId)).length));

    const inference = await this.latest<InferenceAssessment>('inference', projectId);
    if (modelSelection) records.push(fromModelSelection(modelSelection));

    if (inference) records.push(fromInferenceAssessment(inference));

    const architecture = await this.latest<AiInferenceArchitecture>('inference_architecture', projectId);
    if (architecture) records.push(fromInferenceArchitecture(architecture));

    const infrastructure = await this.latest<AiInfrastructureDesign>('infrastructure_design', projectId);
    if (infrastructure) records.push(fromInfrastructureDesign(infrastructure));

    const ragAgent = await this.latest<AiRagAgentDesign>('rag_agent_architecture', projectId);
    if (ragAgent) records.push(fromRagAgentDesign(ragAgent));

    const security = await this.latest<AiSecurityAssessment>('security_governance', projectId);
    if (security) records.push(fromSecurityAssessment(security));

    const performance = await this.latest<AiPerformanceAssessment>('performance_benchmark', projectId);
    if (performance) records.push(fromPerformanceAssessment(performance));

    const finops = await this.latest<AiFinopsAssessment>('finops', projectId);
    if (finops) records.push(fromFinopsAssessment(finops));

    const operations = await this.latest<AiOperationsModel>('operations_model', projectId);
    if (operations) records.push(fromOperationsModel(operations));

    return records;
  }

  /** Embedding catalogue flattened for the eligibility layer (read from the existing embeddings.yaml). */
  private embeddingCatalogue(): EmbeddingModelFacts[] {
    return this.platformConfig.getEmbeddingProviders().flatMap((p) =>
      (p.models ?? []).map((m: Record<string, any>) => ({
        providerId: p.id,
        modelId: m.id,
        label: `${p.label} ${m.label}`,
        dimension: m.dimension,
        maxInputTokens: m.maxInputTokens,
        costPerMillionTokens: m.costPerMillionTokens,
        languageSupport: m.languageSupport ?? [],
        qualityTier: m.qualityTier,
        status: m.status ?? 'active',
      })),
    );
  }

  /** Requirements the embedding choice is judged against, with where each came from. */
  private embeddingContext(pipeline: DataPipelineDesign, profile: AiWorkloadProfile | null, ms: AiModelSelection | null) {
    const rules = this.cfg.getEmbeddingEligibilityRules();
    const chunkTokens = pipeline.chunkingStrategy === ChunkingStrategy.TOKEN_BASED ? pipeline.chunkSize : Math.ceil(pipeline.chunkSize / rules.charsPerToken);
    const targets = (profile?.inputs.deploymentTargets.value ?? []) as string[];
    const selfHostingRequired = ms ? ms.requirements.selfHostingRequired : targets.length === 1 && targets[0] === 'on_premises';
    const multilingual = ms?.requirements.multilingual ?? false;
    const basis = [
      `Self-hosting required: ${selfHostingRequired ? 'yes' : 'no'} (${ms ? `Model Selection v${ms.version}` : profile ? `Workload Profile v${profile.version} deployment targets` : 'no Workload Profile - assumed not required'})`,
      `Multilingual: ${multilingual ? 'yes' : 'no'} (${ms ? `Model Selection v${ms.version}` : 'not stated - assumed single language'})`,
      `Chunk size ~${chunkTokens.toLocaleString()} tokens (${pipeline.chunkSize} ${pipeline.chunkingStrategy === ChunkingStrategy.TOKEN_BASED ? 'tokens' : `characters ÷ ${rules.charsPerToken}`})`,
    ];
    return { chunkTokens, selfHostingRequired, multilingual, basis };
  }

  // -------------------------------------------------------------- overview
  async getOverview(projectId: string, requester: AuthenticatedUser): Promise<AiFactoryOverview> {
    const project = await this.projectsService.findOne(projectId, requester);
    const lineage = await this.getLineage(projectId);
    return {
      rulesVersion: this.cfg.getRulesVersion(),
      steps: this.buildSteps(lineage, project),
      phases: lineage,
      state: await this.buildState(project, lineage),
    };
  }

  private buildSteps(lineage: PhaseLineage[], project: Project): StepState[] {
    const byPhase = new Map(lineage.map((l) => [l.phase, l]));
    return this.cfg.getSteps().map((step) => {
      const phaseStatuses = step.phases.map((k) => {
        const l = byPhase.get(k)!;
        return { phase: k, label: l.label, route: l.route, status: l.status };
      });
      let status: StepStatus;
      if (!phaseStatuses.length && step.key === 'use_case') status = project.businessUseCase ? 'current' : 'in_progress';
      else if (!phaseStatuses.length) status = 'not_yet_available';
      else if (phaseStatuses.some((p) => p.status === 'stale')) status = 'stale';
      else if (phaseStatuses.every((p) => p.status === 'not_started')) status = 'not_started';
      else if (phaseStatuses.some((p) => p.status === 'not_started')) status = 'in_progress';
      else if (phaseStatuses.some((p) => p.status === 'review')) status = 'review';
      else status = 'current';
      return { ...step, status, phaseStatuses };
    });
  }

  /** The estimate drives status and version; observed usage (last 30 days) is added even before an estimate exists. */
  private async tokenSection(base: StateSection, te: AiTokenEstimate | null, projectId: string): Promise<StateSection> {
    const [observed, alerts] = await Promise.all([this.usage.observedState(projectId), this.tokenAlerts.openCount(projectId)]);
    if (!te && !observed.totals && !alerts) return base;
    return { ...base, summary: { ...tokenState(te, observed, alerts) } };
  }

  private async buildState(project: Project, lineage: PhaseLineage[]): Promise<AssessmentState> {
    const L = (k: PhaseKey) => lineage.find((l) => l.phase === k)!;
    const section = (k: PhaseKey, coverage: StateSection['coverage'], summary: Record<string, unknown>): StateSection => {
      const l = L(k);
      return { status: l.status, coverage, source: l.latest ? { phase: k, version: l.latest.version, createdAt: l.latest.createdAt } : null, summary: l.latest ? summary : {} };
    };
    const later = (wave: number): StateSection => ({ status: 'not_yet_available', coverage: 'none', source: null, summary: {}, plannedWave: wave });

    const [d, p, i, adr, dep, opt, cap, inf, wp, ms, ia, infra, ra, sec, perf, fin, ops, fr, te] = await Promise.all([
      this.latest<DiscoveryAssessment>('discovery', project.id),
      this.latest<DataPipelineDesign>('data_embeddings', project.id),
      this.latest<IndexDesign>('index_design', project.id),
      this.latest<ArchitectureDecisionRecord>('vector_db_selection', project.id),
      this.latest<DeploymentPlan>('infrastructure', project.id),
      this.latest<OptimizationReport>('optimization', project.id),
      this.latest<CapacityPlan>('capacity', project.id),
      this.latest<InferenceAssessment>('inference', project.id),
      this.latest<AiWorkloadProfile>('workload_profile', project.id),
      this.latest<AiModelSelection>('model_selection', project.id),
      this.latest<AiInferenceArchitecture>('inference_architecture', project.id),
      this.latest<AiInfrastructureDesign>('infrastructure_design', project.id),
      this.latest<AiRagAgentDesign>('rag_agent_architecture', project.id),
      this.latest<AiSecurityAssessment>('security_governance', project.id),
      this.latest<AiPerformanceAssessment>('performance_benchmark', project.id),
      this.latest<AiFinopsAssessment>('finops', project.id),
      this.latest<AiOperationsModel>('operations_model', project.id),
      this.latest<AiFinalRecommendation>('final_recommendation', project.id),
      this.latest<AiTokenEstimate>('token_observability', project.id),
    ]);
    const profileValue = (k: keyof AiWorkloadProfile['inputs']) => wp?.inputs[k]?.value ?? null;
    const wpResult = wp?.result;

    return {
      // With a Workload Profile these two sections come from it (full coverage); without one, from the project and Discovery as before.
      useCase: wp
        ? section('workload_profile', 'full', {
            name: project.name,
            businessObjective: profileValue('businessObjective'),
            businessDomain: profileValue('businessDomain'),
            businessCriticality: profileValue('businessCriticality'),
            workloadTypes: profileValue('workloadTypes'),
            expectedUsers: profileValue('expectedUsers'),
            applications: profileValue('numberOfApplications'),
            dataSources: profileValue('dataSources'),
            profileStatus: wpResult?.status,
          })
        : {
            status: project.businessUseCase ? 'current' : 'not_started',
            coverage: 'partial',
            source: null,
            summary: { name: project.name, businessUseCase: project.businessUseCase ?? null, industry: project.industry ?? null, patternId: project.patternId ?? null, customerMode: project.customerMode },
            plannedWave: 2,
          },
      scale: wp
        ? section('workload_profile', 'full', {
            workloadSize: wpResult?.workloadSize.tier,
            architecture: wpResult?.architecture.label,
            dataClassification: wpResult?.dataClassification.level,
            deploymentTargets: wpResult?.deploymentRequirements.targets,
            hybrid: wpResult?.deploymentRequirements.hybrid,
            expectedVectorCount: profileValue('expectedVectorCount'),
            dailyRequests: profileValue('dailyRequests'),
            peakQps: profileValue('peakQps'),
            targetTtftMs: profileValue('targetTtftMs'),
            availabilityTargetPercent: profileValue('availabilityTargetPercent'),
          })
        : { ...section('discovery', 'partial', d ? { estimatedVectorCount: d.estimatedVectorCount, documentCount: d.documentCount, qps: d.qps, peakQps: d.peakQps, targetP95LatencyMs: d.targetP95LatencyMs, recallTarget: d.recallTarget, availabilityTargetPercent: d.availabilityTargetPercent, deploymentEnvironment: d.deploymentEnvironment } : {}), plannedWave: 2 },
      data: section('data_embeddings', 'partial', p ? { chunkingStrategy: p.chunkingStrategy, chunkSize: p.chunkSize, chunkOverlap: p.chunkOverlap, metadataFields: (p.metadataFields ?? []).length } : {}),
      embedding: section('data_embeddings', 'full', p ? { provider: p.embeddingProviderId, model: p.embeddingModelId, dimension: p.embeddingDimension, similarityMetric: p.similarityMetric, costPerMillionTokens: p.costPerMillionTokens } : {}),
      vectorDB: section('vector_db_selection', 'full', adr ? { platform: adr.decision, decisionStatus: adr.decisionStatus, confidence: adr.confidence, projectPlatform: project.platform, manualOverride: project.platformIsManualOverride } : {}),
      index: section('index_design', 'full', i ? { index: i.decision, configuration: Object.fromEntries(i.configuration.map((c) => [c.name, c.value])) } : {}),
      model: section('model_selection', 'full', ms ? { primary: ms.result.primary?.label ?? null, secondary: ms.result.secondary?.label ?? null, fallback: ms.result.fallback?.label ?? null, confidence: ms.result.confidence, eligibleCandidates: ms.result.candidates.filter((c) => c.eligibility !== 'not_eligible').length, candidates: ms.result.candidates.length } : {}),
      inference: section('inference', ia ? 'full' : 'partial', inf
        ? {
            decision: inf.decision,
            recommended: inf.result.recommendedGpuOption ? `${inf.result.recommendedGpuOption.totalGpusAtPeak} × ${inf.result.recommendedGpuOption.gpuLabel}` : null,
            selfHostedMonthlyUsd: inf.result.recommendedGpuOption?.monthlyTotalUsd ?? null,
            managedApiMonthlyUsd: inf.result.managedApi.monthlyUsd,
            servingRuntime: ia?.result.recommended?.label ?? null,
            patterns: ia?.context.patterns ?? null,
            architectureVersion: ia?.version ?? null,
          }
        : {}),
      // Spec (Token Observability) §16. Observed figures stay null until usage events exist - never filled from the estimate.
      tokenObservability: await this.tokenSection(section('token_observability', 'partial', {}), te, project.id),
      infrastructure: infra
        ? section('infrastructure_design', 'full', {
            deploymentModel: infra.result.deploymentModel.summary,
            placements: Object.fromEntries(infra.result.placements.map((pl) => [pl.componentLabel, pl.chosen?.label ?? 'not feasible'])),
            confidence: infra.result.confidence,
            vectorDeploymentPlan: dep ? `v${dep.version} (${dep.platform})` : null,
          })
        : { ...section('infrastructure', 'partial', dep ? { platform: dep.platform, executed: dep.executed, hasKubernetes: !!dep.kubernetesArtifacts } : {}), plannedWave: 5 },
      rag: ra
        ? section('rag_agent_architecture', 'full', {
            scope: ra.result.scope.summary,
            decisions: Object.fromEntries(ra.result.decisions.map((x) => [x.title, x.chosen?.label ?? 'no usable option'])),
            contextFits: ra.result.contextBudget.fits,
            timeToFirstTokenMs: ra.result.latencyBudget.timeToFirstTokenMs,
            gaps: ra.result.gaps.length,
            confidence: ra.result.confidence,
          })
        : later(6),
      security: sec
        ? section('security_governance', 'full', {
            overall: sec.result.overall.label,
            validation: sec.result.validation.status,
            components: sec.result.overall.summary,
            requiredControlGaps: sec.result.controls.filter((k) => k.status === 'gap').map((k) => k.label),
          })
        : {
            ...section('discovery', 'partial', d ? { containsPii: d.containsPii, dataResidency: d.dataResidencyRequirement ?? null, encryptionAtRest: d.requiresEncryptionAtRest, encryptionInTransit: d.requiresEncryptionInTransit, keyManagement: d.requiresKeyManagement, rbac: d.requiresRbac, auditLogging: d.requiresAuditLogging, tenantIsolation: d.requiresTenantIsolation, complianceGate: adr?.complianceGate?.status ?? null, ...(wp ? { dataClassification: wpResult?.dataClassification.level, containsPhi: profileValue('containsPhi'), containsPci: profileValue('containsPci'), requiredControls: wpResult?.securityRequirements.controls.length } : {}) } : {}),
            plannedWave: 7,
          },
      performance: perf
        ? section('performance_benchmark', 'full', {
            status: perf.result.status.label,
            statusKey: perf.result.status.status,
            measured: perf.result.counts.pass + perf.result.counts.pass_with_conditions + perf.result.counts.fail,
            requiresBenchmark: perf.result.counts.requires_benchmark,
            failing: perf.result.groups.flatMap((g) => g.metrics).filter((k) => k.status === 'fail').map((k) => k.label),
          })
        : { ...section('optimization', 'partial', opt ? { recall: opt.recommendedVariant.avgRecall, p95LatencyMs: opt.recommendedVariant.p95LatencyMs, achievedQps: opt.recommendedVariant.achievedQps, evidence: 'measured (vector benchmark sample)' } : {}), plannedWave: 8 },
      cost: fin
        ? section('finops', 'full', {
            chosenMonthlyUsd: fin.result.chosen?.monthlyUsd ?? null,
            budget: fin.result.budget.status,
            validation: fin.result.validation.status,
            cheapestAllowed: fin.result.cheapestAllowed?.label ?? null,
            evidence: 'estimated / assumption - not quotes',
          })
        : {
        status: adr || inf ? 'current' : 'not_started',
        coverage: 'partial',
        source: null,
        summary: { vectorDbBudget: adr?.budgetFeasibility ?? null, inferenceSelfHostedMonthlyUsd: inf?.result.recommendedGpuOption?.monthlyTotalUsd ?? null, inferenceManagedApiMonthlyUsd: inf?.result.managedApi.monthlyUsd ?? null, evidence: 'estimated' },
        plannedWave: 9,
      },
      operations: ops
        ? section('operations_model', 'full', {
            verdict: ops.result.verdict.status,
            estimatedAvailabilityPercent: ops.result.definitions.sla.estimatedPercent,
            estimatedRecoveryMinutes: ops.result.definitions.rto.estimatedMinutes,
            operationalLoad: `${ops.result.operationalLoad.total} / ${ops.result.operationalLoad.capacity}`,
            gaps: ops.result.gaps.length,
          })
        : { ...section('capacity', 'partial', cap ? { sharding: cap.shardingRecommendation.strategy, horizonsMonths: cap.forecast.map((f) => f.horizonMonths), ha: cap.haRecommendation.length, dr: cap.drRecommendation.length } : {}), plannedWave: 10 },
      recommendation: fr
        ? section('final_recommendation', 'full', {
            readiness: fr.result.readiness.label,
            confidence: fr.result.executiveSummary.confidence,
            stages: Object.fromEntries(fr.result.readiness.stages.map((g) => [g.stage, g.status])),
            alternatives: fr.result.alternatives.options.length,
          })
        : later(11),
    };
  }

  // --------------------------------------------------------------- snapshots
  async saveSnapshot(projectId: string, requester: AuthenticatedUser, label?: string): Promise<AiFactoryStateSnapshot> {
    const overview = await this.getOverview(projectId, requester);
    const version = (await this.snapshots.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.snapshots.save(
      this.snapshots.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        label: label?.trim() || null,
        state: overview.state,
        lineage: overview.phases,
        rulesVersion: overview.rulesVersion,
      }),
    );
    this.logger.log(`user=${requester.email} action=save_ai_factory_snapshot projectId=${projectId} version=${version}`);
    return saved;
  }

  async listSnapshots(projectId: string, requester: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, requester);
    return this.snapshots.find({ where: { project: { id: projectId } }, order: { version: 'DESC' }, select: { id: true, version: true, label: true, rulesVersion: true, createdAt: true } });
  }

  async compareSnapshots(projectId: string, requester: AuthenticatedUser, from: number, to: number): Promise<SnapshotComparison> {
    await this.projectsService.findOne(projectId, requester);
    const load = async (v: number) => {
      const s = await this.snapshots.findOne({ where: { project: { id: projectId }, version: v } });
      if (!s) throw new BadRequestException(`Snapshot v${v} does not exist for this project.`);
      return s;
    };
    return compareStates(from, (await load(from)).state, to, (await load(to)).state);
  }
}

/** Section-by-section comparison of two saved states. */
export function compareStates(from: number, a: AssessmentState, to: number, b: AssessmentState): SnapshotComparison {
  const keys = Object.keys(b) as Array<keyof AssessmentState>;
  return {
    from,
    to,
    sections: keys.map((section) => {
      const x = a[section], y = b[section];
      const fields = [...new Set([...Object.keys(x?.summary ?? {}), ...Object.keys(y?.summary ?? {})])];
      const changedFields = fields.filter((f) => JSON.stringify(x?.summary?.[f]) !== JSON.stringify(y?.summary?.[f]));
      const sourceChanged = JSON.stringify(x?.source?.version) !== JSON.stringify(y?.source?.version);
      return {
        section,
        change: changedFields.length || sourceChanged || x?.status !== y?.status ? 'changed' : 'unchanged',
        statusFrom: x?.status ?? 'not_started',
        statusTo: y?.status ?? 'not_started',
        changedFields: sourceChanged ? ['source version', ...changedFields] : changedFields,
      };
    }),
  };
}

/** Spec (Token Observability) §16: expected figures from the latest estimate, observed ones from usage events - never one filled from the other. */
export function tokenState(te: AiTokenEstimate | null, observed: Awaited<ReturnType<UsageService['observedState']>>, openAlerts = 0): TokenObservabilityState {
  const r = te?.result;
  const o = observed.totals;
  return {
    mode: observed.telemetry.status === 'receiving' || observed.telemetry.status === 'stale' ? 'live' : observed.telemetry.status === 'simulated_only' ? 'simulated' : 'estimated',
    expectedTokensPerRequest: r?.perRequest.totalTokens ?? null,
    expectedMonthlyTokens: r?.monthly.totalTokens ?? null,
    observedInputTokens: o ? o.inputTokens : null,
    observedOutputTokens: o ? o.outputTokens : null,
    observedTotalTokens: o ? o.totalTokens : null,
    embeddingTokens: o ? o.embeddingTokens : (r?.monthly.embeddingTokens ?? null),
    contextTokens: r?.perRequest.contextTokens ?? null,
    llmCallsPerRequest: r?.perRequest.llmCalls ?? null,
    estimatedCost: r?.cost.monthlyUsd ?? null,
    actualCost: o ? o.cost : null,
    topConsumers: observed.topConsumers,
    alerts: openAlerts,
    telemetryStatus: observed.telemetry.status,
  };
}
