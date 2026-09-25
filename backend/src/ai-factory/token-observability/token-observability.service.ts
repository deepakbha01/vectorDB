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
import { EstimateContext, TokenEstimateResult } from './token-observability.types';

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

  private async resolve(projectId: string) {
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
    // Upstream versions this estimate was built from, for provenance.
    const versions = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, (v as { version?: number } | null)?.version ?? null]));
    return { ...resolved, versions };
  }

  private async estimate(projectId: string, context: EstimateContext, at: Date): Promise<TokenEstimateResult> {
    const cat = this.cfg.getTokenObservabilityCatalogue();
    return estimateTokens(context, await this.pricing.rowsFor(projectId), cat, at, projectId);
  }

  /** The estimate as the upstream records stand now. Saves nothing. */
  async preview(projectId: string, requester: AuthenticatedUser): Promise<{ context: EstimateContext; sources: Record<string, { source: string; detail: string }>; result: TokenEstimateResult }> {
    await this.projectsService.findOne(projectId, requester);
    const { context, sources } = await this.resolve(projectId);
    return { context, sources, result: await this.estimate(projectId, context, new Date()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser): Promise<AiTokenEstimate> {
    await this.projectsService.findOne(projectId, requester);
    const { context, sources, versions } = await this.resolve(projectId);
    const result = await this.estimate(projectId, context, new Date());
    const version = (await this.estimates.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.estimates.save(
      this.estimates.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: {}, context: { ...context, upstreamVersions: versions }, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=token_estimate projectId=${projectId} version=${version} tokensPerRequest=${result.perRequest.totalTokens} monthlyUsd=${result.cost.monthlyUsd ?? 'n/a'}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiTokenEstimate | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.estimates.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
