import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../../data-pipeline/data-pipeline-design.entity';
import { ArchitectureDecisionRecord } from '../../vector-db-selection/architecture-decision-record.entity';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { InferenceConfigService } from '../../inference/inference-config.service';
import { ChunkingStrategy } from '../../chunking/enums/chunking-strategy.enum';
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiInferenceArchitecture } from '../inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from '../infrastructure/infrastructure.entity';
import { vectorPlatforms } from '../infrastructure/infrastructure.service';
import { drTier } from '../operations/dr-tier';
import { InfrastructureCatalogue, TargetId } from '../infrastructure/infrastructure.types';
import { AiFinopsAssessment } from './finops.entity';
import { assessFinops } from './finops.engine';
import { FinopsCatalogue, FinopsContext, FinopsResult } from './finops.types';

const ALL_TARGETS: TargetId[] = ['on_premises', 'azure', 'aws', 'oci', 'gcp'];
const SECONDS_PER_MONTH = 86_400 * 30.4;

export interface FinopsInputs {
  project: Pick<Project, 'platform'>;
  profile: AiWorkloadProfile | null;
  discovery: DiscoveryAssessment | null;
  pipeline: DataPipelineDesign | null;
  adr: ArchitectureDecisionRecord | null;
  inference: InferenceAssessment | null;
  architecture: AiInferenceArchitecture | null;
  infrastructure: AiInfrastructureDesign | null;
}

export interface FinopsCatalogues {
  finops: FinopsCatalogue;
  infrastructure: InfrastructureCatalogue;
  inferencePricing: { selfHostedOverheadPercent: number; platformFixedMonthlyUsd: number };
  gpuListHourly: (gpuId: string) => number | null;
  managedServingIds: string[];
  charsPerToken: number;
}

/** Pure: resolves what is being priced - quantities from the upstream records - and never a price. */
export function resolveFinopsContext(x: FinopsInputs, c: FinopsCatalogues): FinopsContext {
  if (!x.inference && !x.adr) throw new BadRequestException('Nothing to price yet - run the Inference assessment and / or the Vector DB Selection first.');
  const d = x.discovery;
  const inf = x.inference;
  const targets = (x.profile?.inputs.deploymentTargets.value as TargetId[] | null) ?? [];

  const requestsPerMonth = inf?.result.demand.requestsPerMonth ?? (d ? Math.round(d.qps * SECONDS_PER_MONTH) : 0);

  // ------------------------------------------------------------ inference
  let inference: FinopsContext['inference'] = null;
  if (inf) {
    const rec = inf.result.recommendedGpuOption;
    const managedByDesign = !!x.architecture?.result.recommended && c.managedServingIds.includes(x.architecture.result.recommended.id);
    const mode = managedByDesign || !rec || inf.result.decision === 'managed_api' ? 'managed_api' : 'self_hosted';
    inference = {
      mode,
      gpuId: rec?.gpuId ?? null,
      gpuLabel: rec?.gpuLabel ?? null,
      gpusAtPeak: rec?.totalGpusAtPeak ?? null,
      gpuMonthlyListUsd: rec ? (inf.inputsUsed.autoscaling ? rec.monthlyGpuCostAutoscaledUsd : rec.monthlyGpuCostPeakUsd) : 0,
      overheadPercent: c.inferencePricing.selfHostedOverheadPercent,
      platformFixedMonthlyUsd: c.inferencePricing.platformFixedMonthlyUsd,
      managedMonthlyUsd: inf.result.managedApi.monthlyUsd,
      managedTierLabel: inf.result.managedApi.tierLabel ?? null,
      requestsPerMonth: inf.result.demand.requestsPerMonth,
      tokensPerMonth: inf.result.demand.tokensPerMonth,
      weightsGb: rec?.footprint.weightsGb ?? 0,
      source: `Inference assessment v${inf.version}${managedByDesign ? ` (managed serving per Inference Architecture v${x.architecture!.version})` : ''}`,
    };
  }

  // ------------------------------------------------------------ vector DB
  let vector: FinopsContext['vector'] = null;
  if (x.adr) {
    const platform = x.project.platform && x.project.platform !== VectorPlatform.UNDETERMINED ? x.project.platform : x.adr.decision;
    const availability = d?.availabilityTargetPercent ?? 99.5;
    const rule = c.finops.vectorReplicas.find((r) => availability >= r.minAvailability)!;
    const est = x.adr.infrastructureEstimate;
    vector = {
      platform,
      kinds: vectorPlatforms(platform),
      saasTargets: (c.infrastructure.saasAvailability[platform] as TargetId[] | undefined) ?? null,
      cpuCores: est.estimatedCpuCores,
      memoryGb: est.estimatedMemoryGb,
      storageGb: est.estimatedStorageGb,
      replicas: rule.replicas,
      replicaReason: `${rule.replicas} replica(s) for ${availability}% availability (assumption)`,
      source: `Vector DB decision (${platform}) sizing estimate`,
    };
  }

  // ------------------------------------------------------------ embedding
  let embedding: FinopsContext['embedding'] = null;
  const p = x.pipeline;
  if (p && d) {
    const chunkTokens = p.chunkingStrategy === ChunkingStrategy.TOKEN_BASED ? p.chunkSize : Math.ceil(p.chunkSize / c.charsPerToken);
    const corpusTokens = d.documentCount * d.chunksPerDocument * chunkTokens;
    const growth = (d.documentGrowthPercentPerMonth ?? 0) / 100;
    embedding = {
      model: p.embeddingModelId,
      selfHosted: p.embeddingProviderId === 'open_source',
      pricePer1M: p.costPerMillionTokens,
      corpusTokens,
      monthlyNewTokens: Math.round(corpusTokens * growth),
      monthlyQueryTokens: requestsPerMonth * c.finops.embedding.avgQueryTokens,
      reembedTokens: Math.round(corpusTokens * (1 + growth) ** c.finops.embedding.reembedHorizonMonths),
      source: `Data Pipeline Design v${p.version} (${p.embeddingModelId}, ~${chunkTokens} tokens per chunk) and Discovery v${d.version} corpus`,
    };
  }

  // ---------------------------------------------------------- DR tier
  const dr: FinopsContext['dr'] = drTier(d, c.infrastructure.assumptions.warmStandbyRtoMinutes);

  // ----------------------------------------------------- placements
  const infra = x.infrastructure?.result;
  const placements = infra
    ? (Object.fromEntries(infra.placements.filter((pl) => pl.chosen).map((pl) => [pl.component, pl.chosen!.target])) as FinopsContext['placements'])
    : null;

  const budget = d?.monthlyBudgetUsd ?? inf?.inputsUsed.monthlyBudgetUsd ?? null;
  const missing = [!inf && 'Inference assessment', !x.adr && 'Vector DB decision', !(p && d) && 'Data Pipeline Design (embedding costs)'].filter((k): k is string => !!k);

  return {
    allowedTargets: targets.length ? targets : ALL_TARGETS,
    inference,
    vector,
    embedding,
    application: { nodes: c.infrastructure.assumptions.applicationNodes, vcpusPerNode: c.infrastructure.assumptions.applicationVcpusPerNode },
    modelVersionsKept: c.infrastructure.assumptions.modelVersionsKept,
    selfHostedEmbeddingGpuListHourly: c.gpuListHourly(c.finops.embedding.selfHostedGpuId) ?? 0,
    requestsPerMonth,
    dr,
    placements,
    deploymentKind: infra?.deploymentModel.kind ?? null,
    gpuAvailability: Object.fromEntries(ALL_TARGETS.map((t) => [t, c.infrastructure.targets[t].gpus])) as Record<TargetId, string[]>,
    monthlyBudgetUsd: budget || null,
    budgetSource: d?.monthlyBudgetUsd ? `Discovery v${d.version}` : inf?.inputsUsed.monthlyBudgetUsd ? `Inference assessment v${inf.version}` : null,
    missing,
  };
}

@Injectable()
export class FinopsAssessmentService {
  private readonly logger = new Logger(FinopsAssessmentService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    @InjectRepository(AiFinopsAssessment) private readonly assessments: Repository<AiFinopsAssessment>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(DataPipelineDesign) private readonly pipelines: Repository<DataPipelineDesign>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(AiInfrastructureDesign) private readonly infrastructure: Repository<AiInfrastructureDesign>,
  ) {}

  private async resolve(projectId: string, requester: AuthenticatedUser): Promise<FinopsContext> {
    const project = await this.projectsService.findOne(projectId, requester);
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [profile, discovery, pipeline, adr, inference, architecture, infrastructure] = await Promise.all([
      this.profiles.findOne({ where, order }),
      this.discovery.findOne({ where, order }),
      this.pipelines.findOne({ where, order }),
      this.adrs.findOne({ where, order }),
      this.inference.findOne({ where, order }),
      this.architectures.findOne({ where, order }),
      this.infrastructure.findOne({ where, order }),
    ]);
    const pricing = this.inferenceConfig.getPricing();
    return resolveFinopsContext(
      { project, profile, discovery, pipeline, adr, inference, architecture, infrastructure },
      {
        finops: this.cfg.getFinopsCatalogue(),
        infrastructure: this.cfg.getInfrastructureCatalogue(),
        inferencePricing: { selfHostedOverheadPercent: pricing.selfHostedOverheadPercent, platformFixedMonthlyUsd: pricing.platformFixedMonthlyUsd },
        gpuListHourly: (id) => this.inferenceConfig.getGpus().find((g) => g.id === id)?.hourlyUsd ?? null,
        managedServingIds: this.cfg.getServingCatalogue().servingOptions.filter((o) => o.gpuVendors.includes('provider')).map((o) => o.id),
        charsPerToken: this.cfg.getEmbeddingEligibilityRules().charsPerToken,
      },
    );
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: FinopsContext; preview: FinopsResult }> {
    const context = await this.resolve(projectId, requester);
    return { context, preview: assessFinops(context, this.cfg.getFinopsCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser): Promise<AiFinopsAssessment> {
    const context = await this.resolve(projectId, requester);
    const result = assessFinops(context, this.cfg.getFinopsCatalogue());
    const version = (await this.assessments.count({ where: { project: { id: projectId } } })) + 1;
    const sources = { rates: { source: 'default', detail: `config/finops.yaml rate card (assumption, reviewed ${result.ratesReviewed})` } };
    const saved = await this.assessments.save(
      this.assessments.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: {}, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=assess_finops projectId=${projectId} version=${version} monthly=${result.chosen?.monthlyUsd ?? 'n/a'} budget=${result.budget.status}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiFinopsAssessment | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.assessments.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
