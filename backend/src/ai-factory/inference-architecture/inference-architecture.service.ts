import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { AiInferenceArchitecture } from './inference-architecture.entity';
import { designInferenceArchitecture } from './inference-architecture.engine';
import { CreateInferenceArchitectureDto, INFERENCE_PATTERNS } from './create-inference-architecture.dto';
import { InferenceArchitectureResult, InferencePattern, ModelFamily, ServingContext } from './inference-architecture.types';

export type ContextSource = { source: 'user' | 'inference' | 'workload_profile' | 'model_selection' | 'discovery' | 'default'; detail: string };

const STREAMING_WORKLOADS = ['chat', 'rag', 'agent', 'code', 'summarization'];

/** Pure: builds the design context and records where each input came from. */
export function resolveServingContext(
  dto: CreateInferenceArchitectureDto,
  inference: InferenceAssessment,
  profile: AiWorkloadProfile | null,
  selection: AiModelSelection | null,
  discovery: DiscoveryAssessment | null,
): { context: ServingContext; sources: Record<string, ContextSource> } {
  const sources: Record<string, ContextSource> = {};
  const iv = `Inference assessment v${inference.version}`;
  const r = inference.result;
  const i = inference.inputsUsed;
  const rec = r.recommendedGpuOption;
  const decision = r.decision;

  const allowedFamilies: ModelFamily[] =
    decision === 'self_hosted' ? ['open_weight'] : decision === 'managed_api' ? ['proprietary_api'] : decision === 'either' ? ['open_weight', 'proprietary_api'] : [];
  sources.allowedFamilies = { source: 'inference', detail: `${iv}: decision ${decision.replace(/_/g, ' ')}` };

  let patterns: InferencePattern[];
  if (dto.patterns?.length) {
    patterns = dto.patterns;
    sources.patterns = { source: 'user', detail: 'set in the architecture inputs' };
  } else {
    const workload = String(i.workloadType);
    const set = new Set<InferencePattern>(['synchronous']);
    if (STREAMING_WORKLOADS.includes(workload)) set.add('streaming');
    if (workload === 'batch') {
      set.delete('synchronous');
      set.add('batch');
      set.add('asynchronous');
    }
    if (workload === 'agent') set.add('asynchronous');
    if (i.ttftTargetMs < 1000 && workload !== 'batch') set.add('real_time');
    patterns = INFERENCE_PATTERNS.filter((p) => set.has(p));
    sources.patterns = { source: 'inference', detail: `${iv}: ${workload} workload, TTFT target ${i.ttftTargetMs} ms` };
  }

  const pick = <T>(key: string, own: T | undefined, derived: { value: T; detail: string; source: ContextSource['source'] } | null, fallback: T, why: string): T => {
    if (own !== undefined) {
      sources[key] = { source: 'user', detail: 'set in the architecture inputs' };
      return own;
    }
    if (derived) {
      sources[key] = { source: derived.source, detail: derived.detail };
      return derived.value;
    }
    sources[key] = { source: 'default', detail: why };
    return fallback;
  };
  const dv = discovery ? `Discovery v${discovery.version}` : '';
  const pv = profile ? `Workload Profile v${profile.version}` : '';
  const hasKubernetes = pick<boolean | null>('hasKubernetes', dto.hasKubernetes, discovery ? { value: discovery.hasExistingKubernetes, detail: `${dv}: existing Kubernetes`, source: 'discovery' } : null, null, 'not stated');
  const hasGpu = pick<boolean | null>(
    'hasGpu',
    dto.hasGpu,
    profile?.inputs.hasGpu.value !== undefined && profile?.inputs.hasGpu.value !== null
      ? { value: profile.inputs.hasGpu.value as boolean, detail: `${pv}: GPU availability`, source: 'workload_profile' }
      : discovery
        ? { value: discovery.hasGpu, detail: `${dv}: GPU availability`, source: 'discovery' }
        : null,
    null,
    'not stated',
  );
  const deploymentTargets = (profile?.inputs.deploymentTargets.value as string[] | null) ?? [];
  sources.deploymentTargets = profile ? { source: 'workload_profile', detail: `${pv}: allowed targets` } : { source: 'default', detail: 'no Workload Profile - any target allowed' };
  const routing = selection?.result.primary
    ? {
        primary: { label: selection.result.primary.label, family: selection.result.primary.family },
        secondary: selection.result.secondary ? { label: selection.result.secondary.label, family: selection.result.secondary.family } : null,
        fallback: selection.result.fallback ? { label: selection.result.fallback.label, family: selection.result.fallback.family } : null,
      }
    : null;
  sources.routing = selection ? { source: 'model_selection', detail: `Model Selection v${selection.version}` } : { source: 'default', detail: 'no Model Selection - single-model routing' };
  sources.dataClassification = profile ? { source: 'workload_profile', detail: `${pv}: ${profile.result.dataClassification.level}` } : { source: 'inference', detail: `${iv}: PII ${i.containsPii ? 'yes' : 'no'}` };

  const context: ServingContext = {
    inferenceVersion: inference.version,
    inferenceDecision: decision,
    allowedFamilies,
    modelLabel: i.model.label,
    modelParamsB: i.model.paramsB ?? null,
    apiTierLabel: r.managedApi?.tierLabel ?? null,
    precision: rec?.precision ?? null,
    tensorParallel: rec?.tensorParallel ?? 1,
    gpuLabel: rec?.gpuLabel ?? null,
    totalGpusAtPeak: rec?.totalGpusAtPeak ?? null,
    replicas: rec ? { min: rec.minReplicas, average: rec.replicasAtAverage, peak: rec.replicasAtPeak } : null,
    ttftMs: decision === 'managed_api' ? null : rec?.ttftMs ?? null,
    tpotMs: decision === 'managed_api' ? null : rec?.tpotMs ?? null,
    e2eMs: decision === 'managed_api' ? null : rec?.e2eLatencyMs ?? null,
    ttftTargetMs: i.ttftTargetMs,
    tpotTargetMs: i.tpotTargetMs,
    availabilityTargetPercent: i.availabilityTargetPercent,
    peakRps: r.demand.peakRps,
    monthlyCostUsd: decision === 'managed_api' ? r.managedApi.monthlyUsd : rec?.monthlyTotalUsd ?? null,
    patterns,
    deploymentTargets,
    hasKubernetes,
    hasGpu,
    opsCapability: String(i.opsCapability),
    needsMultiLora: selection?.requirements.fineTuning === 'adapter',
    restrictedData: profile?.result.dataClassification.level === 'restricted',
    containsPii: (profile?.inputs.containsPii.value as boolean | null) ?? i.containsPii,
    dataResidency: (profile?.inputs.dataResidencyRequirement.value as string | null) ?? i.dataResidencyRequirement ?? null,
    multiTenant: discovery ? discovery.tenancyModel !== 'single_tenant' : false,
    securityControls: profile?.result.securityRequirements.controls ?? [],
    routing,
  };
  return { context, sources };
}

@Injectable()
export class InferenceArchitectureService {
  private readonly logger = new Logger(InferenceArchitectureService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(AiModelSelection) private readonly selections: Repository<AiModelSelection>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
  ) {}

  private async inputs(projectId: string) {
    const where = { project: { id: projectId } };
    const [inf, profile, selection, discovery] = await Promise.all([
      this.inference.findOne({ where, order: { createdAt: 'DESC' } }),
      this.profiles.findOne({ where, order: { createdAt: 'DESC' } }),
      this.selections.findOne({ where, order: { createdAt: 'DESC' } }),
      this.discovery.findOne({ where, order: { createdAt: 'DESC' } }),
    ]);
    if (!inf) throw new BadRequestException('Run the Inference assessment first - the architecture is designed around its sizing.');
    return { inf, profile, selection, discovery };
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: ServingContext; sources: Record<string, ContextSource>; preview: InferenceArchitectureResult }> {
    await this.projectsService.findOne(projectId, requester);
    const { inf, profile, selection, discovery } = await this.inputs(projectId);
    const resolved = resolveServingContext({}, inf, profile, selection, discovery);
    return { ...resolved, preview: designInferenceArchitecture(resolved.context, this.cfg.getServingCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateInferenceArchitectureDto): Promise<AiInferenceArchitecture> {
    await this.projectsService.findOne(projectId, requester);
    const { inf, profile, selection, discovery } = await this.inputs(projectId);
    const { context, sources } = resolveServingContext(dto, inf, profile, selection, discovery);
    const result = designInferenceArchitecture(context, this.cfg.getServingCatalogue());
    const version = (await this.architectures.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.architectures.save(
      this.architectures.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: dto, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=design_inference_architecture projectId=${projectId} version=${version} runtime=${result.recommended?.id ?? 'none'}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiInferenceArchitecture | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.architectures.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
