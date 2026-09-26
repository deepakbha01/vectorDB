import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../../data-pipeline/data-pipeline-design.entity';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { InferenceConfigService } from '../../inference/inference-config.service';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { AiRagAgentDesign } from '../rag-agent/rag-agent.entity';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiTokenEstimate } from './token-estimate.entity';
import { estimateTokens } from './token-estimate.engine';
import { EstimateInputs, resolveEstimateContext } from './token-estimate.context';
import { PricingService } from './pricing.service';
import { PlatformConfigService } from '../../common/config/platform-config.service';
import { applyInputs, EstimateOverrides, PatternRef, PatternTokenProfile } from './estimate-inputs';
import { EstimateContext, ResolvedInput, TokenEstimateResult } from './token-observability.types';

type Sources = Record<string, { source: string; detail: string }>;

/**
 * Token Observability - Estimated mode (spec §12). Reads the upstream
 * phases' latest records; never changes how they compute.
 */
@Injectable()
export class TokenObservabilityService {
  private readonly logger = new Logger(TokenObservabilityService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    private readonly pricing: PricingService,
    private readonly platformConfig: PlatformConfigService,
    @InjectRepository(AiTokenEstimate) private readonly estimates: Repository<AiTokenEstimate>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(DataPipelineDesign) private readonly pipelines: Repository<DataPipelineDesign>,
    @InjectRepository(AiModelSelection) private readonly modelSelections: Repository<AiModelSelection>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiRagAgentDesign) private readonly designs: Repository<AiRagAgentDesign>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
  ) {}

  private latestOf<T extends { createdAt: Date }>(repo: Repository<T>, projectId: string): Promise<T | null> {
    return repo.findOne({ where: { project: { id: projectId } } as unknown as FindOptionsWhere<T>, order: { createdAt: 'DESC' } as any });
  }

  /** The project's pattern, with its optional token profile (validation spec §1-§2). */
  private patternOf(project: Project): PatternRef | null {
    if (!project.patternId) return null;
    const p = this.platformConfig.getPatternCatalog().find((x) => x.id === project.patternId);
    if (!p) return null;
    return { id: p.id, name: p.name, qps: p.defaultAssessment?.qps ?? null, profile: (p.tokenObservabilityProfile as PatternTokenProfile | undefined) ?? null };
  }

  /** Overrides saved with the latest estimate - reused so a new estimate never drops what the user set. */
  private async savedOverrides(projectId: string): Promise<EstimateOverrides> {
    const last = await this.estimates.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    return ((last?.submitted as { overrides?: EstimateOverrides } | undefined)?.overrides ?? {}) as EstimateOverrides;
  }

  private async resolve(project: Project, overrides: EstimateOverrides) {
    const projectId = project.id;
    const [discovery, pipeline, modelSelection, inference, design, profile] = await Promise.all([
      this.latestOf(this.discovery, projectId),
      this.latestOf(this.pipelines, projectId),
      this.latestOf(this.modelSelections, projectId),
      this.latestOf(this.inference, projectId),
      this.latestOf(this.designs, projectId),
      this.latestOf(this.profiles, projectId),
    ]);
    const inputs: EstimateInputs = { discovery, pipeline, modelSelection, inference, design, profile };
    const resolved = resolveEstimateContext(inputs, {
      ragAgent: this.cfg.getRagAgentCatalogue(),
      avgQueryTokens: this.cfg.getFinopsCatalogue().embedding.avgQueryTokens,
      charsPerToken: this.inferenceConfig.getSizing().charsPerToken,
    });
    const pattern = this.patternOf(project);
    const applied = applyInputs(resolved.context, overrides, {
      pattern,
      discovery: discovery ? { version: discovery.version, qps: discovery.qps } : null,
      inference: inference ? { version: inference.version, requestsPerMonth: inference.result.demand.requestsPerMonth, avgInputTokens: inference.inputsUsed.avgInputTokens, avgOutputTokens: inference.inputsUsed.avgOutputTokens } : null,
      operatingDaysPerMonth: this.cfg.getTokenObservabilityCatalogue().estimation.operatingDaysPerMonth ?? 30.4,
    });
    const sources: Sources = { ...resolved.sources };
    delete sources.requests;
    if (applied.context.requestsSource) sources.requests = { source: applied.context.requestsSource, detail: `${applied.context.requestsPerMonth.toLocaleString()} requests / month` };
    if (pattern) sources.pattern = { source: `Pattern: ${pattern.name}`, detail: pattern.profile ? `LLM usage ${pattern.profile.llmUsage}; ${pattern.profile.workloadType} workload` : 'No token profile' };
    // Upstream versions this estimate was built from, for provenance.
    const versions = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, (v as { version?: number } | null)?.version ?? null]));
    return { context: applied.context, sources, inputs: applied.inputs, versions: { ...versions, patternId: pattern?.id ?? null } };
  }

  private async estimate(projectId: string, context: EstimateContext, inputs: ResolvedInput[], at: Date): Promise<TokenEstimateResult> {
    const cat = this.cfg.getTokenObservabilityCatalogue();
    return { ...estimateTokens(context, await this.pricing.rowsFor(projectId), cat, at, projectId), inputs };
  }

  /** The estimate as the upstream records stand now. Saves nothing. Without overrides, the saved ones apply. */
  async preview(projectId: string, requester: AuthenticatedUser, overrides?: EstimateOverrides): Promise<{ context: EstimateContext; sources: Sources; overrides: EstimateOverrides; result: TokenEstimateResult }> {
    const project = await this.projectsService.findOne(projectId, requester);
    const o = overrides ?? (await this.savedOverrides(projectId));
    const { context, sources, inputs } = await this.resolve(project, o);
    return { context, sources, overrides: o, result: await this.estimate(projectId, context, inputs, new Date()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, overrides?: EstimateOverrides): Promise<AiTokenEstimate> {
    const project = await this.projectsService.findOne(projectId, requester);
    const o = overrides ?? (await this.savedOverrides(projectId));
    const { context, sources, inputs, versions } = await this.resolve(project, o);
    const result = await this.estimate(projectId, context, inputs, new Date());
    const version = (await this.estimates.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.estimates.save(
      this.estimates.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: { overrides: o }, context: { ...context, upstreamVersions: versions }, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=token_estimate projectId=${projectId} version=${version} tokensPerRequest=${result.perRequest.totalTokens} monthlyUsd=${result.cost.monthlyUsd ?? 'n/a'}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiTokenEstimate | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.estimates.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
