import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { DeploymentEnvironment } from '../../discovery/enums/discovery.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from './workload-profile.entity';
import { CreateWorkloadProfileDto } from './create-workload-profile.dto';
import { buildWorkloadProfile } from './workload-profile.engine';
import { DeploymentTarget, ResolvedProfileInputs, ResolvedValue, WorkloadProfileResult } from './workload-profile.types';

const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Resolves each profile answer from, in order: what the user typed, the
 * latest Discovery assessment, the project record, or a derivation - and
 * records which, so nothing is asked twice and nothing is silently assumed.
 * Pure so it can be unit-tested and reused for the form's defaults.
 */
export function resolveProfileInputs(dto: Partial<CreateWorkloadProfileDto>, discovery: DiscoveryAssessment | null, project: Pick<Project, 'industry' | 'businessUseCase'>): ResolvedProfileInputs {
  const dv = discovery ? `Discovery v${discovery.version}` : undefined;
  const pick = <T>(own: T | undefined, fromDiscovery?: T | null, fromProject?: T | null): ResolvedValue<T> => {
    if (!blank(own)) return { value: own as T, source: 'profile' };
    if (discovery && !blank(fromDiscovery)) return { value: fromDiscovery as T, source: 'discovery', detail: dv };
    if (!blank(fromProject)) return { value: fromProject as T, source: 'project', detail: 'project details' };
    return { value: null, source: 'missing' };
  };

  const dailyRequests: ResolvedValue<number> = !blank(dto.dailyRequests)
    ? { value: dto.dailyRequests!, source: 'profile' }
    : discovery && discovery.qps > 0
      ? { value: Math.round(discovery.qps * 86400), source: 'derived', detail: `${dv} qps ${discovery.qps} × 86,400` }
      : { value: null, source: 'missing' };

  // Discovery only knows cloud / on-prem / hybrid; only "on-premises" names a concrete target.
  const deploymentTargets = pick<DeploymentTarget[]>(dto.deploymentTargets, discovery?.deploymentEnvironment === DeploymentEnvironment.ON_PREMISES ? [DeploymentTarget.ON_PREMISES] : null);

  return {
    businessObjective: pick(dto.businessObjective, null, project.businessUseCase ?? null),
    businessDomain: pick(dto.businessDomain, null, project.industry ?? null),
    businessCriticality: pick(dto.businessCriticality),
    expectedUsers: pick(dto.expectedUsers),
    numberOfApplications: pick(dto.numberOfApplications),
    businessSla: pick(dto.businessSla),
    workloadTypes: pick(dto.workloadTypes),
    dataSources: pick(dto.dataSources),
    dataTypes: pick(dto.dataTypes),
    documentCount: pick(dto.documentCount, discovery?.documentCount),
    expectedVectorCount: pick(dto.expectedVectorCount, discovery?.estimatedVectorCount),
    dailyRequests,
    peakQps: pick(dto.peakQps, discovery?.peakQps),
    concurrentUsers: pick(dto.concurrentUsers, discovery?.concurrentUsers),
    dataGrowthPercentPerMonth: pick(dto.dataGrowthPercentPerMonth, discovery?.documentGrowthPercentPerMonth),
    targetLatencyMs: pick(dto.targetLatencyMs),
    targetTtftMs: pick(dto.targetTtftMs),
    throughputRps: pick(dto.throughputRps),
    availabilityTargetPercent: pick(dto.availabilityTargetPercent, discovery?.availabilityTargetPercent),
    deploymentTargets,
    hasGpu: pick<boolean>(undefined, discovery?.hasGpu),
    containsPii: pick(dto.containsPii, discovery?.containsPii),
    containsPhi: pick(dto.containsPhi),
    containsPci: pick(dto.containsPci),
    confidentialData: pick(dto.confidentialData),
    dataResidencyRequirement: pick(dto.dataResidencyRequirement, discovery?.dataResidencyRequirement),
    requiresEncryptionAtRest: pick<boolean>(undefined, discovery?.requiresEncryptionAtRest),
    requiresEncryptionInTransit: pick<boolean>(undefined, discovery?.requiresEncryptionInTransit),
    regulatoryRequirements: pick(dto.regulatoryRequirements, discovery?.regulatoryRequirements),
  };
}

@Injectable()
export class WorkloadProfileService {
  private readonly logger = new Logger(WorkloadProfileService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
  ) {}

  private latestDiscovery(projectId: string) {
    return this.discovery.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /** What the form would be pre-filled with (nothing is saved). */
  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ inputs: ResolvedProfileInputs; preview: WorkloadProfileResult }> {
    const project = await this.projectsService.findOne(projectId, requester);
    const inputs = resolveProfileInputs({}, await this.latestDiscovery(projectId), project);
    return { inputs, preview: buildWorkloadProfile(inputs, this.cfg.getWorkloadProfileRules()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateWorkloadProfileDto): Promise<AiWorkloadProfile> {
    const project = await this.projectsService.findOne(projectId, requester);
    const inputs = resolveProfileInputs(dto, await this.latestDiscovery(projectId), project);
    const result = buildWorkloadProfile(inputs, this.cfg.getWorkloadProfileRules());
    const version = (await this.profiles.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.profiles.save(
      this.profiles.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        submitted: dto,
        inputs,
        result,
        rulesVersion: this.cfg.getRulesVersion(),
      }),
    );
    this.logger.log(`user=${requester.email} action=submit_workload_profile projectId=${projectId} version=${version} size=${result.workloadSize.tier} architecture=${result.architecture.class}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiWorkloadProfile | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<AiWorkloadProfile[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.profiles.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
