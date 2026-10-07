import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/auth.service';
import { Project } from '../projects/project.entity';
import { ProjectsService } from '../projects/projects.service';
import { User } from '../users/user.entity';
import { AzureConnection } from './azure-connection.entity';
import { AzureEnvironmentProfile } from './azure-environment-profile.entity';
import { AzureRole, ConnectionSource, ProfileSource } from './azure-builder.enums';
import { DISCOVERY_QUERIES, SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile, deriveConstraints, ProfileFormInput, readResourceGraphRows, validateEnvironmentProfile } from './environment-profile';
import { CreateAzureConnectionDto, CreateEnvironmentProfileDto } from './dto/azure-builder.dto';
import { CreateUseCaseDto, OverridePatternDto } from './dto/use-case.dto';
import { AzureUseCase } from './azure-use-case.entity';
import { DiscoveryService } from '../discovery/discovery.service';
import { buildUseCaseSpec, classifyUseCase, IntakeAnswers, SolutionPattern, SOLUTION_PATTERNS, validateIntake } from './use-case-spec';
import { prefillIntake } from './use-case-prefill';
import { AzureArchitecture } from './azure-architecture.entity';
import { ArchitectureError, DEFAULT_OPTIONS, designArchitecture } from './architecture';
import { loadAzureCatalog } from './architecture-catalog';
import { GenerateArchitectureDto } from './dto/architecture.dto';

/** What the declared role allows. Offline it is the user's word; the live wave reads Microsoft.Authorization. */
export interface PermissionLevel {
  role: AzureRole;
  canDesign: boolean;
  canDeploy: boolean;
  verified: boolean;
  note: string;
}

export function permissionFor(role: AzureRole, source: ConnectionSource): PermissionLevel {
  const canDeploy = role === AzureRole.OWNER || role === AzureRole.CONTRIBUTOR;
  const verified = source === ConnectionSource.LIVE;
  const note = canDeploy
    ? `${role === AzureRole.OWNER ? 'Owner' : 'Contributor'} can design and deploy into this scope.`
    : role === AzureRole.READER
      ? 'Reader can design but deployment is blocked - ask for Contributor on the target resource group.'
      : 'Role not known - design is allowed; deployment stays blocked until the role is confirmed.';
  return { role, canDesign: true, canDeploy, verified, note: verified ? note : `${note} (Declared, not yet verified against Azure.)` };
}

export interface AzureBuilderState {
  connection: (AzureConnection & { permission: PermissionLevel }) | null;
  environmentProfile: AzureEnvironmentProfile | null;
  /** True when the latest profile was taken for an older connection (e.g. the region changed) - re-run Discover. */
  profileStale: boolean;
  /** Latest UseCaseSpec version (Phase 2), or null before intake. */
  useCase: AzureUseCase | null;
  /** Latest ArchitectureSpec version (Phase 3), or null before the first design. */
  architecture: AzureArchitecture | null;
  /** True when a newer use case or Environment Profile exists than the architecture was designed from. */
  architectureStale: boolean;
}

/**
 * Azure AI Factory Builder - Phases 0 (Connect), 1 (Discover), 2 (Use case intake) and 3 (Architect).
 * Offline-first: no Azure call is made and no credential is accepted or stored.
 */
@Injectable()
export class AzureBuilderService {
  private readonly logger = new Logger(AzureBuilderService.name);

  constructor(
    @InjectRepository(AzureConnection) private readonly connections: Repository<AzureConnection>,
    @InjectRepository(AzureEnvironmentProfile) private readonly profiles: Repository<AzureEnvironmentProfile>,
    @InjectRepository(AzureUseCase) private readonly useCases: Repository<AzureUseCase>,
    @InjectRepository(AzureArchitecture) private readonly architectures: Repository<AzureArchitecture>,
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
  ) {}

  async getState(projectId: string, user: AuthenticatedUser): Promise<AzureBuilderState> {
    await this.projectsService.findOne(projectId, user); // enforces access
    const connection = await this.latestConnection(projectId);
    const environmentProfile = await this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    const active = connection?.active ? connection : null;
    const useCase = await this.latestUseCase(projectId);
    const architecture = await this.latestArchitecture(projectId);
    return {
      connection: active ? { ...active, permission: permissionFor(active.role, active.source) } : null,
      environmentProfile,
      profileStale: !!(active && environmentProfile && environmentProfile.connectionVersion !== active.version),
      useCase,
      architecture,
      architectureStale: !!(architecture && (architecture.useCaseVersion !== useCase?.version || architecture.profileVersion !== environmentProfile?.version)),
    };
  }

  // ---- Phase 2 - Use case intake ----

  /** Wizard defaults from what the project already knows (name, use case, connection, Evectorize Discovery). */
  async intakePrefill(projectId: string, user: AuthenticatedUser) {
    const project = await this.projectsService.findOne(projectId, user);
    const connection = await this.latestConnection(projectId);
    const discovery = await this.discoveryService.getLatest(projectId, user).catch(() => null);
    return {
      ...prefillIntake(project, connection?.active ? connection : null, discovery?.assessment ?? null),
      patterns: SOLUTION_PATTERNS,
    };
  }

  /** Classifies the answers and stores a new UseCaseSpec version (spec 4.3). */
  async submitUseCase(projectId: string, user: AuthenticatedUser, dto: CreateUseCaseDto) {
    await this.projectsService.findOne(projectId, user);
    const answers = this.toAnswers(dto);
    const problems = validateIntake(answers);
    if (problems.length) throw new BadRequestException(problems);
    const classification = classifyUseCase(answers);
    const saved = await this.saveUseCase(projectId, user, buildUseCaseSpec(answers, classification, user.email), classification);
    this.logger.log(`user=${user.email} action=azure_builder_intake projectId=${projectId} version=${saved.version} pattern=${classification.pattern} risk=${classification.riskClass}`);
    return saved;
  }

  /** Records an architect's override of the classified pattern as a new version; the classifier's output is kept. */
  async overridePattern(projectId: string, user: AuthenticatedUser, dto: OverridePatternDto) {
    await this.projectsService.findOne(projectId, user);
    const latest = await this.latestUseCase(projectId);
    if (!latest) throw new BadRequestException('Complete the use case intake before overriding its pattern.');
    const { pattern: _pattern, owner, ...answers } = latest.spec;
    const spec = buildUseCaseSpec(answers, latest.classification, owner, { pattern: dto.pattern as SolutionPattern, reason: dto.reason.trim(), by: user.email });
    const saved = await this.saveUseCase(projectId, user, spec, latest.classification);
    this.logger.log(`user=${user.email} action=azure_builder_pattern_override projectId=${projectId} version=${saved.version} from=${latest.classification.pattern} to=${dto.pattern}`);
    return saved;
  }

  async useCaseHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.useCases.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  private async saveUseCase(projectId: string, user: AuthenticatedUser, spec: AzureUseCase['spec'], classification: AzureUseCase['classification']) {
    const version = (await this.useCases.count({ where: { project: { id: projectId } } })) + 1;
    return this.useCases.save(this.useCases.create({ project: { id: projectId } as Project, createdBy: { id: user.id } as User, version, spec, classification }));
  }

  private latestUseCase(projectId: string) {
    return this.useCases.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /** Normalises the DTO: trims text, lower-cases regions, drops blank KPIs. */
  private toAnswers(dto: CreateUseCaseDto): IntakeAnswers {
    return {
      name: dto.name.trim(),
      business: { problem: dto.business.problem.trim(), kpis: dto.business.kpis.map((k) => k.trim()).filter(Boolean), sponsor: dto.business.sponsor.trim(), costCenter: dto.business.costCenter.trim() },
      users: { type: dto.users.type, count: dto.users.count, peakConcurrent: dto.users.peakConcurrent, channels: [...new Set(dto.users.channels)] },
      data: dto.data.map((d) => ({ ...d, source: d.source.trim(), format: d.format.trim() })),
      constraints: {
        regions: [...new Set(dto.constraints.regions.map((r) => r.trim().toLowerCase().replace(/\s+/g, '')).filter(Boolean))],
        dataResidency: dto.constraints.dataResidency?.trim() || null,
        compliance: dto.constraints.compliance.map((c) => c.trim()).filter(Boolean),
        latencyMs: dto.constraints.latencyMs ?? null,
        availability: dto.constraints.availability?.trim() || null,
        monthlyBudgetUsd: dto.constraints.monthlyBudgetUsd ?? null,
      },
      environment: dto.environment,
    };
  }

  // ---- Phase 3 - Architect ----

  /** Runs the rules engine on the latest use case and Environment Profile and stores a new ArchitectureSpec version. */
  async generateArchitecture(projectId: string, user: AuthenticatedUser, dto: GenerateArchitectureDto) {
    await this.projectsService.findOne(projectId, user);
    const useCase = await this.latestUseCase(projectId);
    if (!useCase) throw new BadRequestException('Complete the use case intake (Phase 2) before designing the architecture.');
    const connection = await this.latestConnection(projectId);
    if (!connection?.active) throw new BadRequestException('Connect a target subscription (Phase 0) before designing the architecture.');
    const profile = await this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    if (!profile) throw new BadRequestException('Run Discover (Phase 1) before designing the architecture.');
    if (profile.connectionVersion !== connection.version) throw new BadRequestException('The connection changed since the last Discover - run Discover (Phase 1) again first.');

    const options = {
      apiGateway: dto.apiGateway === undefined ? DEFAULT_OPTIONS.apiGateway : dto.apiGateway,
      chatHistory: dto.chatHistory ?? DEFAULT_OPTIONS.chatHistory,
      deployment: dto.deployment ?? DEFAULT_OPTIONS.deployment,
    };
    let spec;
    try {
      spec = designArchitecture({
        useCase: useCase.spec,
        useCaseId: useCase.id,
        useCaseVersion: useCase.version,
        profile: profile.profile,
        profileVersion: profile.version,
        connection: { region: connection.region, deploymentModel: connection.deploymentModel },
        options,
        catalog: loadAzureCatalog(),
      });
    } catch (err) {
      if (err instanceof ArchitectureError) throw new BadRequestException(err.message);
      throw err;
    }
    const version = (await this.architectures.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.architectures.save(
      this.architectures.create({ project: { id: projectId } as Project, createdBy: { id: user.id } as User, version, useCaseVersion: useCase.version, profileVersion: profile.version, spec }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_architect projectId=${projectId} version=${version} components=${spec.components.length} monthlyUsd=${spec.cost.monthlyUsd}`);
    return saved;
  }

  async architectureHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.architectures.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  private latestArchitecture(projectId: string) {
    return this.architectures.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async connect(projectId: string, user: AuthenticatedUser, dto: CreateAzureConnectionDto) {
    await this.projectsService.findOne(projectId, user);
    const version = (await this.connections.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.connections.save(
      this.connections.create({
        ...dto,
        region: dto.region.toLowerCase(),
        subscriptionName: dto.subscriptionName ?? null,
        source: ConnectionSource.DECLARED,
        active: true,
        version,
        project: { id: projectId } as Project,
        createdBy: { id: user.id } as User,
      }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_connect projectId=${projectId} version=${version}`);
    return { ...saved, permission: permissionFor(saved.role, saved.source) };
  }

  /** Records a disconnected version - history is kept, nothing is deleted. */
  async disconnect(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    const current = await this.latestConnection(projectId);
    if (!current?.active) throw new BadRequestException('This project has no active Azure connection.');
    const { id: _id, createdAt: _createdAt, ...rest } = current;
    await this.connections.save(this.connections.create({ ...rest, active: false, version: current.version + 1, createdBy: { id: user.id } as User }));
    return { disconnected: true, subscriptionId: current.subscriptionId };
  }

  async connectionHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.connections.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async discover(projectId: string, user: AuthenticatedUser, dto: CreateEnvironmentProfileDto) {
    await this.projectsService.findOne(projectId, user);
    const connection = await this.latestConnection(projectId);
    if (!connection?.active) throw new BadRequestException('Connect a target subscription (Phase 0) before running Discover.');

    let rows: Array<Record<string, unknown>> = [];
    let problems: string[] = [];
    let form: ProfileFormInput = (dto.form ?? {}) as ProfileFormInput;
    let subscriptionId = connection.subscriptionId;
    if (dto.source === ProfileSource.SAMPLE) {
      rows = SAMPLE_RESOURCE_GRAPH_ROWS;
      form = SAMPLE_FORM_INPUT;
      subscriptionId = SAMPLE_SUBSCRIPTION_ID;
      problems = ['Sample environment - not read from your subscription. Replace it with your own Resource Graph output before relying on it.'];
    } else if (dto.source === ProfileSource.RESOURCE_GRAPH) {
      if (dto.resourceGraph === undefined || dto.resourceGraph === null || dto.resourceGraph === '') {
        throw new BadRequestException('Paste the Resource Graph output, or choose the form or the sample.');
      }
      ({ rows, problems } = readResourceGraphRows(dto.resourceGraph));
      if (rows.length === 0 && problems.length) throw new BadRequestException(problems.join(' '));
    }

    const profile = buildEnvironmentProfile(subscriptionId, rows, form, new Date().toISOString());
    const errors = validateEnvironmentProfile(profile);
    if (errors.length) throw new BadRequestException(errors);

    const version = (await this.profiles.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.profiles.save(
      this.profiles.create({
        project: { id: projectId } as Project,
        createdBy: { id: user.id } as User,
        version,
        connectionVersion: connection.version,
        source: dto.source,
        profile,
        constraints: deriveConstraints(profile, connection.region),
        problems,
      }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_discover projectId=${projectId} version=${version} source=${dto.source} rows=${rows.length}`);
    return saved;
  }

  async profileHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.profiles.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  discoveryQueries() {
    return DISCOVERY_QUERIES;
  }

  private latestConnection(projectId: string) {
    return this.connections.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
