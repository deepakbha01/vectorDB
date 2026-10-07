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
}

/**
 * Azure AI Factory Builder - Phases 0 (Connect) and 1 (Discover).
 * Offline-first: no Azure call is made and no credential is accepted or stored.
 */
@Injectable()
export class AzureBuilderService {
  private readonly logger = new Logger(AzureBuilderService.name);

  constructor(
    @InjectRepository(AzureConnection) private readonly connections: Repository<AzureConnection>,
    @InjectRepository(AzureEnvironmentProfile) private readonly profiles: Repository<AzureEnvironmentProfile>,
    private readonly projectsService: ProjectsService,
  ) {}

  async getState(projectId: string, user: AuthenticatedUser): Promise<AzureBuilderState> {
    await this.projectsService.findOne(projectId, user); // enforces access
    const connection = await this.latestConnection(projectId);
    const environmentProfile = await this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    const active = connection?.active ? connection : null;
    return {
      connection: active ? { ...active, permission: permissionFor(active.role, active.source) } : null,
      environmentProfile,
      profileStale: !!(active && environmentProfile && environmentProfile.connectionVersion !== active.version),
    };
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
