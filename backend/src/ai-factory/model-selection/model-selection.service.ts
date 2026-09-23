import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiModelSelection } from './model-selection.entity';
import { CreateModelSelectionDto } from './create-model-selection.dto';
import { selectModels } from './model-selection.engine';
import { ModelRequirements, ModelSelectionResult } from './model-selection.types';

export type RequirementSource = { source: 'user' | 'workload_profile' | 'default'; detail: string };

/**
 * Model requirements from, in order: what the user set, what the AI Workload
 * Profile implies, or a stated default - with the reason recorded for each,
 * so the decision record can show why a requirement was assumed.
 */
export function resolveModelRequirements(dto: CreateModelSelectionDto, profile: AiWorkloadProfile | null): { requirements: ModelRequirements; sources: Record<string, RequirementSource> } {
  const sources: Record<string, RequirementSource> = {};
  const pv = profile ? `Workload Profile v${profile.version}` : '';
  const r = profile?.result;
  const components = r?.architecture.components ?? [];
  const workloadTypes = (profile?.inputs.workloadTypes.value ?? []) as string[];
  const targets = (profile?.inputs.deploymentTargets.value ?? []) as string[];
  const criticality = profile?.inputs.businessCriticality.value as string | null | undefined;
  const ttft = profile?.inputs.targetTtftMs.value as number | null | undefined;

  function pick<T>(key: keyof CreateModelSelectionDto, fromProfile: { value: T; why: string } | null, fallback: T, fallbackWhy: string): T {
    const own = dto[key] as T | undefined;
    if (own !== undefined && own !== null) {
      sources[key] = { source: 'user', detail: 'set in model requirements' };
      return own;
    }
    if (profile && fromProfile) {
      sources[key] = { source: 'workload_profile', detail: `${pv}: ${fromProfile.why}` };
      return fromProfile.value;
    }
    sources[key] = { source: 'default', detail: fallbackWhy };
    return fallback;
  }

  const requirements: ModelRequirements = {
    requiredContextTokens: pick('requiredContextTokens', null, 8192, 'default 8,192 tokens - set it from the longest prompt + output'),
    reasoningComplexity: pick(
      'reasoningComplexity',
      components.includes('agent') ? { value: 'high' as const, why: 'agent workloads plan multi-step actions' } : components.includes('search') && components.length === 1 ? { value: 'low' as const, why: 'search-only workload' } : null,
      'medium',
      'default medium',
    ),
    accuracyRequirement: pick(
      'accuracyRequirement',
      criticality ? { value: criticality === 'mission_critical' ? ('critical' as const) : criticality === 'high' ? ('high' as const) : ('standard' as const), why: `business criticality ${criticality}` } : null,
      'standard',
      'default standard',
    ),
    multilingual: pick('multilingual', null, false, 'not stated - assumed single language'),
    multimodal: pick('multimodal', r ? { value: r.dataClassification.multimodal, why: r.dataClassification.multimodal ? 'multimodal data types' : 'no image, audio or video data' } : null, false, 'not stated'),
    toolCalling: pick('toolCalling', r ? { value: components.includes('agent') || components.includes('copilot'), why: `architecture ${r.architecture.label ?? 'unclassified'}` } : null, false, 'not stated'),
    structuredOutput: pick(
      'structuredOutput',
      r ? { value: components.includes('agent') || workloadTypes.includes('classification'), why: components.includes('agent') ? 'agents exchange structured tool calls' : workloadTypes.includes('classification') ? 'classification output' : 'no structured-output workload' } : null,
      false,
      'not stated',
    ),
    codeGeneration: pick('codeGeneration', null, false, 'not stated'),
    fineTuning: pick('fineTuning', null, 'none', 'not stated - no fine-tuning assumed'),
    selfHostingRequired: pick(
      'selfHostingRequired',
      targets.length ? { value: targets.length === 1 && targets[0] === 'on_premises', why: targets.length === 1 && targets[0] === 'on_premises' ? 'on-premises-only deployment' : `deployment targets ${targets.join(' + ')}` } : null,
      false,
      'not stated - third-party APIs allowed',
    ),
    permissiveLicenceOnly: pick('permissiveLicenceOnly', null, false, 'not stated - community licences allowed after review'),
    maxSelfHostedParamsB: dto.maxSelfHostedParamsB,
    restrictedData: r?.dataClassification.level === 'restricted',
    latencyPriority: pick('latencyPriority', ttft ? { value: ttft < 1000 ? ('high' as const) : ('medium' as const), why: `TTFT target ${ttft} ms` } : null, 'medium', 'default medium'),
    costPriority: pick('costPriority', null, 'medium', 'default medium'),
    domain: pick('domain', profile?.inputs.businessDomain.value ? { value: profile.inputs.businessDomain.value as string, why: 'business domain' } : null, undefined as unknown as string, 'not stated'),
  };
  if (dto.maxSelfHostedParamsB !== undefined) sources.maxSelfHostedParamsB = { source: 'user', detail: 'set in model requirements' };
  sources.restrictedData = profile ? { source: 'workload_profile', detail: `${pv}: data classification ${r?.dataClassification.level}` } : { source: 'default', detail: 'no Workload Profile - not restricted' };
  return { requirements, sources };
}

@Injectable()
export class ModelSelectionService {
  private readonly logger = new Logger(ModelSelectionService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    @InjectRepository(AiModelSelection) private readonly selections: Repository<AiModelSelection>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
  ) {}

  private latestProfile(projectId: string) {
    return this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /** Requirements the form would start from, plus a preview selection. Saves nothing. */
  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ requirements: ModelRequirements; sources: Record<string, RequirementSource>; preview: ModelSelectionResult }> {
    await this.projectsService.findOne(projectId, requester);
    const resolved = resolveModelRequirements({}, await this.latestProfile(projectId));
    return { ...resolved, preview: selectModels(resolved.requirements, this.cfg.getModelCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateModelSelectionDto): Promise<AiModelSelection> {
    await this.projectsService.findOne(projectId, requester);
    const { requirements, sources } = resolveModelRequirements(dto, await this.latestProfile(projectId));
    const result = selectModels(requirements, this.cfg.getModelCatalogue());
    const version = (await this.selections.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.selections.save(
      this.selections.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        submitted: dto,
        requirements,
        sources,
        result,
        rulesVersion: result.rulesVersion,
      }),
    );
    this.logger.log(`user=${requester.email} action=submit_model_selection projectId=${projectId} version=${version} primary=${result.primary?.id ?? 'none'}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiModelSelection | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.selections.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<AiModelSelection[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.selections.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
