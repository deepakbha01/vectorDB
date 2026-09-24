import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InferenceAssessment } from './inference-assessment.entity';
import { CreateInferenceAssessmentDto, CUSTOM_MODEL_ID } from './dto/create-inference-assessment.dto';
import { InferenceEngineService } from './inference-engine.service';
import { InferenceConfigService } from './inference-config.service';
import { GpuPricingModel, InferenceDefaultsSuggestion, InferenceEngineInput, InferenceWorkloadType, ModelSpec } from './inference.types';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { AuthenticatedUser } from '../auth/auth.service';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';

@Injectable()
export class InferenceService {
  private readonly logger = new Logger(InferenceService.name);

  constructor(
    @InjectRepository(InferenceAssessment) private readonly assessments: Repository<InferenceAssessment>,
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
    private readonly dataPipelineService: DataPipelineDesignService,
    private readonly engine: InferenceEngineService,
    private readonly cfg: InferenceConfigService,
  ) {}

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateInferenceAssessmentDto): Promise<InferenceAssessment> {
    await this.projectsService.findOne(projectId, requester); // enforces access
    const input = this.resolveInput(dto);
    const result = this.engine.assess(input);

    const previousCount = await this.assessments.count({ where: { project: { id: projectId } } });
    const saved = await this.assessments.save(
      this.assessments.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version: previousCount + 1,
        submitted: dto,
        inputsUsed: input,
        decision: result.decision,
        result,
        rulesVersion: result.rulesVersion,
      }),
    );
    this.logger.log(`user=${requester.email} action=submit_inference_assessment projectId=${projectId} version=${saved.version} decision=${result.decision}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<InferenceAssessment | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.assessments.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<InferenceAssessment[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.assessments.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /**
   * Suggested intake values from this project's vector-DB track (read-only).
   * A RAG system makes one generation call per retrieval query, so the vector
   * track's QPS, top-K and chunk size translate directly into inference load
   * and prompt size.
   */
  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<InferenceDefaultsSuggestion> {
    const suggestion: InferenceDefaultsSuggestion = { source: [] };
    const discovery = await this.discoveryService.getLatest(projectId, requester);
    const sizing = this.cfg.getSizing();
    if (discovery) {
      const a = discovery.assessment;
      suggestion.source.push(`Vector Discovery assessment v${a.version}`);
      suggestion.workloadType = InferenceWorkloadType.RAG;
      if (a.qps > 0) {
        suggestion.requestsPerDay = Math.round(a.qps * 86400);
        suggestion.peakToAverageRatio = Math.max(1, Math.round((a.peakQps / a.qps) * 10) / 10);
      }
      suggestion.availabilityTargetPercent = a.availabilityTargetPercent;
      suggestion.containsPii = a.containsPii;
      suggestion.dataResidencyRequirement = a.dataResidencyRequirement || undefined;
      suggestion.monthlyBudgetUsd = a.monthlyBudgetUsd ?? undefined;

      const pipeline = await this.dataPipelineService.getLatest(projectId, requester);
      if (pipeline && a.topK > 0) {
        const chunkTokens = pipeline.chunkingStrategy === ChunkingStrategy.TOKEN_BASED
          ? pipeline.chunkSize
          : Math.ceil(pipeline.chunkSize / (sizing.charsPerToken ?? 4));
        suggestion.source.push(`Data Pipeline Design v${pipeline.version} (top-${a.topK} × ~${chunkTokens}-token chunks)`);
        suggestion.ragContextTokens = a.topK * chunkTokens;
        suggestion.avgInputTokens = suggestion.ragContextTokens + (sizing.ragPromptOverheadTokens ?? 500);
      }
    }
    return suggestion;
  }

  getCatalogue() {
    return this.cfg.getCatalogueForUi();
  }

  /** DTO -> engine input: catalogue lookups, custom-model assembly, price overrides, defaults. */
  resolveInput(dto: CreateInferenceAssessmentDto): InferenceEngineInput {
    let model: ModelSpec | undefined;
    if (dto.modelId === CUSTOM_MODEL_ID) {
      model = {
        id: CUSTOM_MODEL_ID,
        label: dto.customModelName || 'Custom model',
        paramsB: dto.customParamsB!,
        activeParamsB: dto.customActiveParamsB ?? dto.customParamsB!,
        layers: dto.customLayers!,
        kvHeads: dto.customKvHeads!,
        headDim: dto.customHeadDim!,
        maxContextTokens: dto.customMaxContextTokens!,
        licence: 'Custom model - confirm licence terms for commercial serving',
      };
      if (model.activeParamsB > model.paramsB) throw new BadRequestException('Active parameters cannot exceed total parameters.');
    } else {
      model = this.cfg.getModels().find((m) => m.id === dto.modelId);
      if (!model) throw new BadRequestException(`Unknown model '${dto.modelId}'. Use a catalogue id or '${CUSTOM_MODEL_ID}'.`);
    }

    const precision = dto.precision ?? 'auto';
    if (precision !== 'auto' && !this.cfg.getPrecisions().some((p) => p.id === precision)) {
      throw new BadRequestException(`Unknown precision '${precision}'.`);
    }

    const tier = this.cfg.getManagedApiTiers().find((t) => t.id === dto.managedApiTierId);
    if (!tier) throw new BadRequestException(`Unknown managed API tier '${dto.managedApiTierId}'.`);

    const knownGpus = new Set(this.cfg.getGpus().map((g) => g.id));
    const unknownGpus = (dto.allowedGpuIds ?? []).filter((g) => !knownGpus.has(g));
    if (unknownGpus.length) throw new BadRequestException(`Unknown GPU id(s): ${unknownGpus.join(', ')}.`);

    if (dto.avgInputTokens + dto.avgOutputTokens > dto.maxContextTokens) {
      throw new BadRequestException('Average input + output tokens cannot exceed the maximum context.');
    }

    return {
      workloadType: dto.workloadType,
      modelSourcing: dto.modelSourcing,
      model,
      precision,
      managedApiTier: {
        ...tier,
        inputPer1M: dto.apiInputPricePer1M ?? tier.inputPer1M,
        outputPer1M: dto.apiOutputPricePer1M ?? tier.outputPer1M,
      },
      requestsPerDay: dto.requestsPerDay,
      peakToAverageRatio: dto.peakToAverageRatio,
      avgInputTokens: dto.avgInputTokens,
      avgOutputTokens: dto.avgOutputTokens,
      maxContextTokens: dto.maxContextTokens,
      ttftTargetMs: dto.ttftTargetMs,
      tpotTargetMs: dto.tpotTargetMs,
      availabilityTargetPercent: dto.availabilityTargetPercent,
      gpuPricing: dto.gpuPricing ?? GpuPricingModel.ON_DEMAND,
      allowedGpuIds: dto.allowedGpuIds?.length ? dto.allowedGpuIds : undefined,
      autoscaling: dto.autoscaling ?? true,
      allowThirdPartyApi: dto.allowThirdPartyApi,
      containsPii: dto.containsPii,
      dataResidencyRequirement: dto.dataResidencyRequirement || undefined,
      monthlyBudgetUsd: dto.monthlyBudgetUsd,
      monthlyGrowthPercent: dto.monthlyGrowthPercent ?? 0,
      opsCapability: dto.opsCapability,
    };
  }
}
