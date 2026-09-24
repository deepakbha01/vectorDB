import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { ArchitectureDecisionRecord } from '../../vector-db-selection/architecture-decision-record.entity';
import { CapacityPlan } from '../../capacity-planning/capacity-plan.entity';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { InferenceConfigService } from '../../inference/inference-config.service';
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { AiInferenceArchitecture } from '../inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from '../infrastructure/infrastructure.entity';
import { vectorPlatforms } from '../infrastructure/infrastructure.service';
import { TargetId } from '../infrastructure/infrastructure.types';
import { AiRagAgentDesign } from '../rag-agent/rag-agent.entity';
import { AiOperationsModel } from './operations.entity';
import { assessOperations } from './operations.engine';
import { drTier } from './dr-tier';
import { CreateOperationsModelDto } from './create-operations-model.dto';
import { OperationsArea, OperationsContext, OperationsResult, Statement } from './operations.types';

export type OperationsSource = { source: 'user' | 'default' | 'upstream'; detail: string };
/** Discovery's operational capability on the inference assessment's scale (as elsewhere in the AI Factory). */
const DISCOVERY_OPS: Record<string, string> = { none: 'none', part_time: 'part_time', dedicated_dba: 'part_time', platform_team: 'platform_team' };

export interface OperationsInputs {
  project: Pick<Project, 'platform'>;
  discovery: DiscoveryAssessment | null;
  adr: ArchitectureDecisionRecord | null;
  capacity: CapacityPlan | null;
  inference: InferenceAssessment | null;
  selection: AiModelSelection | null;
  architecture: AiInferenceArchitecture | null;
  infrastructure: AiInfrastructureDesign | null;
  ragAgent: AiRagAgentDesign | null;
}

export interface OperationsCatalogues {
  warmStandbyRtoMinutes: number;
  modelVersionsKept: number;
  vectorReplicas: Array<{ minAvailability: number; replicas: number }>;
  managedServingIds: string[];
  gpuTargetUtilization: number | null;
}

/** Pure: builds the operations context from the latest records and says where each fact came from. */
export function resolveOperationsContext(dto: CreateOperationsModelDto, x: OperationsInputs, c: OperationsCatalogues) {
  if (!x.discovery && !x.inference) throw new BadRequestException('Nothing to operate yet - complete Discovery or the Inference assessment first.');
  const d = x.discovery;
  const sources: Record<string, OperationsSource> = {};
  const statements: Partial<Record<OperationsArea, Statement[]>> = {};
  const add = (area: OperationsArea, source: string, lines: string[] | undefined) => {
    if (lines?.length) statements[area] = [...(statements[area] ?? []), ...lines.map((text) => ({ source, text }))];
  };

  const availability = d?.availabilityTargetPercent ?? x.inference?.inputsUsed.availabilityTargetPercent ?? 99.5;
  const opsCapability = x.inference ? String(x.inference.inputsUsed.opsCapability) : DISCOVERY_OPS[d!.operationalCapability] ?? 'part_time';
  sources.opsCapability = { source: 'upstream', detail: x.inference ? `Inference assessment v${x.inference.version}: MLOps capability` : `Discovery v${d!.version}: operational capability` };
  sources.onCallCoverage = dto.onCallCoverage ? { source: 'user', detail: 'set in the operations inputs' } : { source: 'default', detail: 'not stated' };
  sources.drTested = dto.drTested !== undefined ? { source: 'user', detail: 'set in the operations inputs' } : { source: 'default', detail: 'not stated - assumed not rehearsed' };

  // inference
  const inf = x.inference;
  const rec = inf?.result.recommendedGpuOption ?? null;
  const archOption = x.architecture?.result.recommended ?? null;
  const managed = !!inf && (inf.result.decision === 'managed_api' || !rec || (!!archOption && c.managedServingIds.includes(archOption.id)));
  const inference: OperationsContext['inference'] = inf
    ? { managed, minReplicas: rec?.minReplicas ?? 1, weightsGb: rec?.footprint.weightsGb ?? 0, servingLabel: archOption?.label ?? (managed ? 'managed API' : 'self-hosted serving'), gpuUtilizationTarget: managed ? null : c.gpuTargetUtilization, ttftTargetMs: inf.inputsUsed.ttftTargetMs ?? null }
    : null;
  const arch = x.architecture?.result.architecture;
  if (arch) {
    const s = `Inference Architecture v${x.architecture!.version}`;
    add('autoscaling', s, arch.autoscaling);
    add('load_balancing', s, arch.loadBalancing);
    add('high_availability', s, arch.replicaStrategy);
    add('failover', s, arch.fallback);
    add('observability', s, arch.observability);
  }

  // vector database
  let vector: OperationsContext['vector'] = null;
  if (x.adr) {
    const platform = x.project.platform && x.project.platform !== VectorPlatform.UNDETERMINED ? x.project.platform : x.adr.decision;
    const replicas = c.vectorReplicas.find((r) => availability >= r.minAvailability)?.replicas ?? 1;
    vector = { platform, kinds: vectorPlatforms(platform), storageGb: x.adr.infrastructureEstimate.estimatedStorageGb, memoryGb: x.adr.infrastructureEstimate.estimatedMemoryGb, replicas };
  }

  // deployment
  const infra = x.infrastructure;
  let deployment: OperationsContext['deployment'] = null;
  if (infra && infra.result.deploymentModel.kind !== 'not_feasible') {
    const targets = [...new Set(infra.result.placements.map((p) => p.chosen?.target).filter((t): t is TargetId => !!t))];
    deployment = { targets, kind: infra.result.deploymentModel.kind, multipleOnPremSites: infra.context.multipleOnPremSites, hasKubernetes: infra.context.hasKubernetes };
    const s = `Infrastructure Design v${infra.version}`;
    add('autoscaling', s, infra.result.sections.scaling);
    add('high_availability', s, infra.result.sections.availability);
    add('disaster_recovery', s, infra.result.sections.disasterRecovery);
  }

  // capacity
  const cap = x.capacity;
  if (cap) {
    const s = `Capacity plan v${cap.version}`;
    add('high_availability', s, cap.haRecommendation);
    add('disaster_recovery', s, cap.drRecommendation);
    add('capacity_planning', s, cap.recommendedInfrastructure);
  }

  const r = x.selection?.result;
  const models = r?.primary ? { primary: r.primary.label, secondary: r.secondary?.label ?? null, fallback: r.fallback?.label ?? null } : null;
  const toolAccess = x.ragAgent?.context.toolAccess;
  const agentActs = !!x.ragAgent?.result.scope.agent && (toolAccess === 'read_write' || toolAccess === 'external_actions');

  const context: OperationsContext = {
    availabilityTargetPercent: availability,
    rpoMinutes: d?.rpoMinutes ?? null,
    rtoMinutes: d?.rtoMinutes ?? null,
    opsCapability,
    onCallCoverage: dto.onCallCoverage ?? null,
    drTested: dto.drTested ?? false,
    dr: drTier(d, c.warmStandbyRtoMinutes),
    deployment,
    inference,
    vector,
    models,
    modelVersionsKept: c.modelVersionsKept,
    agentActs,
    capacity: cap
      ? {
          version: cap.version,
          horizons: cap.forecast.map((f) => ({ months: f.horizonMonths, storageGb: f.estimatedStorageGb, memoryGb: f.estimatedMemoryGb, triggers: f.scalingTriggersHit })),
          sharding: cap.shardingRecommendation.strategy,
        }
      : null,
    statements,
    missing: [!d && 'Discovery (RTO, RPO, availability target)', !infra && 'Infrastructure Design', !inf && 'Inference assessment'].filter((k): k is string => !!k),
  };
  if (d) sources.targets = { source: 'upstream', detail: `Discovery v${d.version}: availability ${availability}%, RPO ${d.rpoMinutes} min, RTO ${d.rtoMinutes} min` };
  return { context, sources };
}

@Injectable()
export class OperationsModelService {
  private readonly logger = new Logger(OperationsModelService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    @InjectRepository(AiOperationsModel) private readonly models: Repository<AiOperationsModel>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(CapacityPlan) private readonly capacity: Repository<CapacityPlan>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiModelSelection) private readonly selections: Repository<AiModelSelection>,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(AiInfrastructureDesign) private readonly infrastructure: Repository<AiInfrastructureDesign>,
    @InjectRepository(AiRagAgentDesign) private readonly ragAgent: Repository<AiRagAgentDesign>,
  ) {}

  private async resolve(projectId: string, requester: AuthenticatedUser, dto: CreateOperationsModelDto) {
    const project = await this.projectsService.findOne(projectId, requester);
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [discovery, adr, capacity, inference, selection, architecture, infrastructure, ragAgent] = await Promise.all([
      this.discovery.findOne({ where, order }),
      this.adrs.findOne({ where, order }),
      this.capacity.findOne({ where, order }),
      this.inference.findOne({ where, order }),
      this.selections.findOne({ where, order }),
      this.architectures.findOne({ where, order }),
      this.infrastructure.findOne({ where, order }),
      this.ragAgent.findOne({ where, order }),
    ]);
    const infraCat = this.cfg.getInfrastructureCatalogue();
    return resolveOperationsContext(
      dto,
      { project, discovery, adr, capacity, inference, selection, architecture, infrastructure, ragAgent },
      {
        warmStandbyRtoMinutes: infraCat.assumptions.warmStandbyRtoMinutes,
        modelVersionsKept: infraCat.assumptions.modelVersionsKept,
        vectorReplicas: this.cfg.getFinopsCatalogue().vectorReplicas,
        managedServingIds: this.cfg.getServingCatalogue().servingOptions.filter((o) => o.gpuVendors.includes('provider')).map((o) => o.id),
        gpuTargetUtilization: this.inferenceConfig.getSizing().targetUtilization ?? null,
      },
    );
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: OperationsContext; sources: Record<string, OperationsSource>; preview: OperationsResult }> {
    const resolved = await this.resolve(projectId, requester, {});
    return { ...resolved, preview: assessOperations(resolved.context, this.cfg.getOperationsCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateOperationsModelDto): Promise<AiOperationsModel> {
    const { context, sources } = await this.resolve(projectId, requester, dto);
    const result = assessOperations(context, this.cfg.getOperationsCatalogue());
    const version = (await this.models.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.models.save(
      this.models.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: dto, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=model_operations projectId=${projectId} version=${version} verdict=${result.verdict.status} sla=${result.definitions.sla.estimatedPercent} rto=${result.definitions.rto.estimatedMinutes}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiOperationsModel | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.models.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
