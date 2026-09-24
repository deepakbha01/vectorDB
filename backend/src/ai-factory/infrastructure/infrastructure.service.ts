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
import { EMBEDDED_LIBRARY_PLATFORMS, FULLY_MANAGED_SAAS_PLATFORMS, K8S_SELF_HOSTABLE_PLATFORMS, SQL_BASED_PLATFORMS, VectorPlatform } from '../../projects/enums/platform.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiInferenceArchitecture } from '../inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from './infrastructure.entity';
import { designInfrastructure } from './infrastructure.engine';
import { CreateInfrastructureDesignDto } from './create-infrastructure-design.dto';
import { ComponentNeed, InfraContext, InfrastructureResult, PlatformKind, ServingFacts, TargetId } from './infrastructure.types';

export type InfraSource = { source: 'user' | 'workload_profile' | 'discovery' | 'inference' | 'inference_architecture' | 'vector_db_selection' | 'capacity' | 'default'; detail: string };

const ALL_TARGETS: TargetId[] = ['on_premises', 'azure', 'aws', 'oci', 'gcp'];
/** Discovery's operational capability expressed on the inference assessment's scale (a DBA runs VMs, not a platform). */
const DISCOVERY_OPS: Record<string, string> = { none: 'none', part_time: 'part_time', dedicated_dba: 'part_time', platform_team: 'platform_team' };

/** Deployment platforms a vector database can use, from the platform groups the codebase already defines. */
export function vectorPlatforms(platform: string): PlatformKind[] {
  const p = platform as VectorPlatform;
  if (FULLY_MANAGED_SAAS_PLATFORMS.includes(p)) return ['saas'];
  if (EMBEDDED_LIBRARY_PLATFORMS.includes(p)) return ['in_app'];
  if (SQL_BASED_PLATFORMS.includes(p)) return ['vm', 'managed'];
  if (K8S_SELF_HOSTABLE_PLATFORMS.includes(p)) return ['kubernetes'];
  return ['kubernetes', 'vm'];
}

export interface InfraInputs {
  project: Pick<Project, 'platform'>;
  profile: AiWorkloadProfile | null;
  discovery: DiscoveryAssessment | null;
  inference: InferenceAssessment | null;
  architecture: AiInferenceArchitecture | null;
  adr: ArchitectureDecisionRecord | null;
  capacity: CapacityPlan | null;
}

/** Pure: builds the placement context from the latest records and says where each input came from. */
export function resolveInfraContext(dto: CreateInfrastructureDesignDto, x: InfraInputs, serving: ServingFacts, gpuMemory: (id: string) => number | null, haThreshold: number) {
  const sources: Record<string, InfraSource> = {};
  const pv = x.profile ? `Workload Profile v${x.profile.version}` : '';
  const dv = x.discovery ? `Discovery v${x.discovery.version}` : '';

  const targets = (x.profile?.inputs.deploymentTargets.value as TargetId[] | null) ?? [];
  const allowedTargets = targets.length ? targets : ALL_TARGETS;
  sources.allowedTargets = targets.length ? { source: 'workload_profile', detail: `${pv}: allowed targets` } : { source: 'default', detail: 'no Workload Profile - every target considered' };

  const pick = <T>(key: string, own: T | undefined, derived: { value: T; source: InfraSource['source']; detail: string } | null, fallback: T, why: string): T => {
    if (own !== undefined) {
      sources[key] = { source: 'user', detail: 'set in the infrastructure inputs' };
      return own;
    }
    if (derived) {
      sources[key] = { source: derived.source, detail: derived.detail };
      return derived.value;
    }
    sources[key] = { source: 'default', detail: why };
    return fallback;
  };
  const hasKubernetes = pick<boolean | null>('hasKubernetes', dto.hasKubernetes, x.discovery ? { value: x.discovery.hasExistingKubernetes, source: 'discovery', detail: `${dv}: existing Kubernetes` } : null, null, 'not stated');
  const profileGpu = x.profile?.inputs.hasGpu.value;
  const hasGpu = pick<boolean | null>(
    'hasGpu',
    dto.hasGpu,
    profileGpu !== undefined && profileGpu !== null ? { value: profileGpu as boolean, source: 'workload_profile', detail: `${pv}: GPU availability` } : x.discovery ? { value: x.discovery.hasGpu, source: 'discovery', detail: `${dv}: GPU availability` } : null,
    null,
    'not stated',
  );
  const multipleOnPremSites = pick('multipleOnPremSites', dto.multipleOnPremSites, null, false, 'not stated - assumed a single on-premises site');
  const opsCapability = pick(
    'opsCapability',
    undefined,
    x.inference
      ? { value: String(x.inference.inputsUsed.opsCapability), source: 'inference', detail: `Inference assessment v${x.inference.version}: MLOps capability` }
      : x.discovery
        ? { value: DISCOVERY_OPS[x.discovery.operationalCapability] ?? 'part_time', source: 'discovery', detail: `${dv}: operational capability` }
        : null,
    'part_time',
    'not stated - assumed part-time',
  );
  const availabilityTargetPercent = pick('availabilityTargetPercent', undefined, x.discovery ? { value: x.discovery.availabilityTargetPercent, source: 'discovery', detail: `${dv}: availability target` } : x.inference ? { value: x.inference.inputsUsed.availabilityTargetPercent, source: 'inference', detail: `Inference assessment v${x.inference.version}` } : null, 99.5, 'default 99.5%');

  const components: ComponentNeed[] = [];
  let inferenceFacts: InfraContext['inference'] = null;
  const rec = x.inference?.result.recommendedGpuOption ?? null;
  if (x.architecture?.result.recommended) {
    const option = serving.options.find((o) => o.id === x.architecture!.result.recommended!.id);
    const managed = !!option?.managed;
    const platforms: PlatformKind[] = managed ? ['managed'] : option?.requiresKubernetes ? ['kubernetes'] : ['vm'];
    const needsGpu = !managed && !!option?.requiresGpu && !!rec;
    components.push({ id: 'inference', label: 'Inference serving', platforms, gpuId: needsGpu ? rec!.gpuId : null, gpuLabel: needsGpu ? rec!.gpuLabel : null, detail: x.architecture.result.recommended.label });
    sources.inferencePlatform = { source: 'inference_architecture', detail: `Inference Architecture v${x.architecture.version}: ${x.architecture.result.recommended.label}` };
    inferenceFacts = {
      servingOption: x.architecture.result.recommended.label,
      managed,
      gpuLabel: rec?.gpuLabel ?? null,
      gpuMemoryGb: rec ? gpuMemory(rec.gpuId) : null,
      totalGpusAtPeak: rec?.totalGpusAtPeak ?? null,
      tensorParallel: rec?.tensorParallel ?? 1,
      replicas: rec ? { min: rec.minReplicas, average: rec.replicasAtAverage, peak: rec.replicasAtPeak } : null,
      weightsGb: rec?.footprint.weightsGb ?? null,
      autoscaling: x.architecture.result.architecture?.autoscaling[0] ?? null,
    };
  } else if (x.inference) {
    const managed = x.inference.result.decision === 'managed_api';
    components.push({ id: 'inference', label: 'Inference serving', platforms: managed ? ['managed'] : ['kubernetes', 'vm'], gpuId: !managed && rec ? rec.gpuId : null, gpuLabel: !managed && rec ? rec.gpuLabel : null, detail: 'from the Inference assessment (no architecture yet)' });
    sources.inferencePlatform = { source: 'inference', detail: `Inference assessment v${x.inference.version} - design the Inference Architecture to fix the runtime platform` };
    inferenceFacts = { servingOption: managed ? 'Managed API' : 'Self-hosted (runtime not chosen yet)', managed, gpuLabel: rec?.gpuLabel ?? null, gpuMemoryGb: rec ? gpuMemory(rec.gpuId) : null, totalGpusAtPeak: rec?.totalGpusAtPeak ?? null, tensorParallel: rec?.tensorParallel ?? 1, replicas: rec ? { min: rec.minReplicas, average: rec.replicasAtAverage, peak: rec.replicasAtPeak } : null, weightsGb: rec?.footprint.weightsGb ?? null, autoscaling: null };
  }

  let vectorFacts: InfraContext['vector'] = null;
  if (x.adr) {
    const platform = x.project.platform && x.project.platform !== VectorPlatform.UNDETERMINED ? x.project.platform : x.adr.decision;
    components.push({ id: 'vector_database', label: 'Vector database', platforms: vectorPlatforms(platform), gpuId: null, gpuLabel: null, saasId: platform, detail: platform });
    sources.vectorPlatform = { source: 'vector_db_selection', detail: `Vector DB decision: ${platform}${platform !== x.adr.decision ? ' (manual override on the project)' : ''}` };
    const last = x.capacity?.forecast[x.capacity.forecast.length - 1];
    vectorFacts = {
      platform,
      memoryGb: x.adr.infrastructureEstimate.estimatedMemoryGb,
      storageGb: x.adr.infrastructureEstimate.estimatedStorageGb,
      cpuCores: x.adr.infrastructureEstimate.estimatedCpuCores,
      forecastStorageGb: last?.estimatedStorageGb ?? null,
      forecastHorizonMonths: last?.horizonMonths ?? null,
    };
    if (x.capacity) sources.capacity = { source: 'capacity', detail: `Capacity plan v${x.capacity.version}` };
  }
  if (!components.length) throw new BadRequestException('Nothing to place yet - run the Vector DB Selection and / or the Inference assessment first.');
  components.push({ id: 'application', label: 'Application / gateway', platforms: ['kubernetes', 'vm'], gpuId: null, gpuLabel: null, detail: 'AI application, inference gateway, policy engine and router' });

  const context: InfraContext = {
    allowedTargets,
    restrictedData: x.profile?.result.dataClassification.level === 'restricted',
    dataResidency: (x.profile?.inputs.dataResidencyRequirement.value as string | null) ?? x.discovery?.dataResidencyRequirement ?? null,
    availabilityTargetPercent,
    haThreshold,
    rpoMinutes: x.discovery?.rpoMinutes ?? null,
    rtoMinutes: x.discovery?.rtoMinutes ?? null,
    requiresMultiRegion: x.discovery?.requiresMultiRegion ?? false,
    regionalFailover: x.discovery?.regionalFailoverRequired ?? false,
    hasKubernetes,
    hasGpu,
    multipleOnPremSites,
    opsCapability,
    components,
    vector: vectorFacts,
    inference: inferenceFacts,
    securityControls: x.profile?.result.securityRequirements.controls ?? [],
  };
  if (x.discovery) sources.availabilityAndDr = { source: 'discovery', detail: `${dv}: availability, RPO / RTO, multi-region` };
  return { context, sources };
}

@Injectable()
export class InfrastructureDesignService {
  private readonly logger = new Logger(InfrastructureDesignService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    @InjectRepository(AiInfrastructureDesign) private readonly designs: Repository<AiInfrastructureDesign>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(CapacityPlan) private readonly capacity: Repository<CapacityPlan>,
  ) {}

  private servingFacts(): ServingFacts {
    return {
      options: this.cfg.getServingCatalogue().servingOptions.map((o) => ({ id: o.id, requiresKubernetes: o.requiresKubernetes, requiresGpu: o.requiresGpu, managed: o.gpuVendors.includes('provider') })),
    };
  }

  private async resolve(projectId: string, requester: AuthenticatedUser, dto: CreateInfrastructureDesignDto) {
    const project = await this.projectsService.findOne(projectId, requester);
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [profile, discovery, inference, architecture, adr, capacity] = await Promise.all([
      this.profiles.findOne({ where, order }),
      this.discovery.findOne({ where, order }),
      this.inference.findOne({ where, order }),
      this.architectures.findOne({ where, order }),
      this.adrs.findOne({ where, order }),
      this.capacity.findOne({ where, order }),
    ]);
    const gpuMemory = (id: string) => this.inferenceConfig.getGpus().find((g) => g.id === id)?.memoryGb ?? null;
    const haThreshold = this.inferenceConfig.getSizing().haAvailabilityThreshold ?? 99.9;
    return resolveInfraContext(dto, { project, profile, discovery, inference, architecture, adr, capacity }, this.servingFacts(), gpuMemory, haThreshold);
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: InfraContext; sources: Record<string, InfraSource>; preview: InfrastructureResult }> {
    const resolved = await this.resolve(projectId, requester, {});
    return { ...resolved, preview: designInfrastructure(resolved.context, this.cfg.getInfrastructureCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateInfrastructureDesignDto): Promise<AiInfrastructureDesign> {
    const { context, sources } = await this.resolve(projectId, requester, dto);
    const result = designInfrastructure(context, this.cfg.getInfrastructureCatalogue());
    const version = (await this.designs.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.designs.save(
      this.designs.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: dto, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=design_infrastructure projectId=${projectId} version=${version} model=${result.deploymentModel.kind} targets=${result.deploymentModel.targets.join('+')}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiInfrastructureDesign | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
