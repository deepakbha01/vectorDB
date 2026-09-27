import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/auth.service';
import { ProjectsService } from '../projects/projects.service';
import { Project } from '../projects/project.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { User, UserRole } from '../users/user.entity';
import { ConnectionField, fieldsFor } from '../database-adapters/connection/connection-fields';
import { ProjectConnectionProfile } from '../database-adapters/connection/project-connection-profile.entity';
import { seal, unseal } from '../database-adapters/connection/secret-box';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { VectorDatabaseAdapter } from '../database-adapters/vector-database-adapter.interface';

const MAX_VALUE_CHARS = 2000;
const TEST_TIMEOUT_MS = 10_000;

/** Error text without connection strings (which can carry credentials). */
const scrub = (raw: string) => raw.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]*@[^\s]*/gi, '[connection]').slice(0, 300);

/**
 * A project's own connection to its target database. Secret settings are
 * write-only: they are stored sealed and only ever reported as set or not.
 */
@Injectable()
export class ConnectionProfilesService {
  private readonly logger = new Logger(ConnectionProfilesService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly factory: VectorAdapterFactory,
    @InjectRepository(ProjectConnectionProfile) private readonly profiles: Repository<ProjectConnectionProfile>,
  ) {}

  private assertCanChange(requester: AuthenticatedUser): void {
    if (requester.role !== UserRole.ADMIN && requester.role !== UserRole.ARCHITECT) throw new ForbiddenException('Only admins and architects can change a connection.');
  }

  private async projectWithFields(projectId: string, requester: AuthenticatedUser): Promise<{ project: Project; fields: ConnectionField[] }> {
    const project = await this.projectsService.findOne(projectId, requester);
    if (project.platform === VectorPlatform.UNDETERMINED) throw new BadRequestException('This project has no target platform yet. Complete Vector DB Selection first.');
    const fields = fieldsFor(project.platform);
    if (!fields) throw new BadRequestException(`A project connection is not available for ${project.platform}; it uses the server's settings.`);
    return { project, fields };
  }

  /** The stored settings for `platform`, opened; {} when there are none for it. */
  private stored(profile: ProjectConnectionProfile | null, platform: string): Record<string, string> {
    if (!profile || profile.platform !== platform) return {};
    const key = this.factory.secretKey();
    if (!key) throw new BadRequestException('The server has no valid CONNECTION_SECRET_KEY, so project connections cannot be read or changed.');
    try {
      return JSON.parse(unseal(profile.settingsSealed, key)) as Record<string, string>;
    } catch {
      throw new BadRequestException("The stored connection cannot be opened with the server's CONNECTION_SECRET_KEY (was the key changed?). Remove it and save it again.");
    }
  }

  /** Stored settings with `changes` applied: omitted keeps, '' clears. Unknown names and non-text values are refused. */
  private merge(fields: ConnectionField[], current: Record<string, string>, changes: Record<string, unknown>): Record<string, string> {
    const known = new Set(fields.map((f) => f.key));
    const next: Record<string, string> = {};
    for (const f of fields) if (current[f.key]) next[f.key] = current[f.key];
    for (const [k, v] of Object.entries(changes)) {
      if (!known.has(k)) throw new BadRequestException(`'${k}' is not a connection setting for this platform.`);
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new BadRequestException(`'${k}' must be text.`);
      const s = String(v).trim();
      if (s.length > MAX_VALUE_CHARS) throw new BadRequestException(`'${k}' is longer than ${MAX_VALUE_CHARS} characters.`);
      if (s === '') delete next[k];
      else next[k] = s;
    }
    return next;
  }

  private view(platform: string, fields: ConnectionField[], profile: ProjectConnectionProfile | null, settings: Record<string, string>) {
    const own = profile && profile.platform === platform ? profile : null;
    return {
      platform,
      source: own ? ('project' as const) : ('server' as const),
      encryptionAvailable: this.factory.secretKey() !== null,
      // A profile saved for the project's previous platform is kept but not used.
      inactiveProfileFor: profile && !own ? profile.platform : null,
      updatedAt: own?.updatedAt ?? null,
      updatedBy: own?.updatedBy?.email ?? null,
      fields: fields.map((f) => ({ ...f, set: own ? own.keysSet.includes(f.key) : false, value: own && !f.secret ? settings[f.key] ?? null : null })),
    };
  }

  private load(projectId: string): Promise<ProjectConnectionProfile | null> {
    return this.profiles.findOne({ where: { project: { id: projectId } }, relations: { updatedBy: true } });
  }

  async get(projectId: string, requester: AuthenticatedUser) {
    const { project, fields } = await this.projectWithFields(projectId, requester);
    const profile = await this.load(project.id);
    // Non-secret values are shown back; if the profile cannot be opened, names only.
    let settings: Record<string, string> = {};
    try {
      settings = this.stored(profile, project.platform);
    } catch {
      settings = {};
    }
    return this.view(project.platform, fields, profile, settings);
  }

  async save(projectId: string, requester: AuthenticatedUser, changes: Record<string, unknown>) {
    this.assertCanChange(requester);
    const { project, fields } = await this.projectWithFields(projectId, requester);
    const key = this.factory.secretKey();
    if (!key) throw new BadRequestException('Set CONNECTION_SECRET_KEY on the server (32 bytes, hex or base64) before saving a project connection. Settings are never stored unencrypted.');
    const profile = await this.load(project.id);
    const settings = this.merge(fields, this.stored(profile, project.platform), changes);
    const missing = fields.filter((f) => f.required && !settings[f.key]).map((f) => f.label);
    if (missing.length) throw new BadRequestException(`Missing: ${missing.join(', ')}.`);
    const row = profile ?? this.profiles.create({ project: { id: project.id } as Project });
    row.platform = project.platform;
    row.settingsSealed = seal(JSON.stringify(settings), key);
    row.keysSet = Object.keys(settings).sort();
    row.updatedBy = { id: requester.id, email: requester.email } as User;
    const saved = await this.profiles.save(row);
    return this.view(project.platform, fields, saved, settings);
  }

  /** Back to the server's settings. */
  async remove(projectId: string, requester: AuthenticatedUser) {
    this.assertCanChange(requester);
    const project = await this.projectsService.findOne(projectId, requester);
    const result = await this.profiles.delete({ project: { id: project.id } });
    return { removed: (result.affected ?? 0) > 0, source: 'server' as const };
  }

  /**
   * A health check against the connection in use (the project's or the
   * server's), or - with `changes` - against the stored settings with those
   * applied, before they are saved. Errors come back without connection strings.
   */
  async test(projectId: string, requester: AuthenticatedUser, changes?: Record<string, unknown>) {
    this.assertCanChange(requester);
    const { project, fields } = await this.projectWithFields(projectId, requester);
    let adapter: VectorDatabaseAdapter;
    let source: 'project' | 'server' | 'unsaved';
    const trial = !!changes && Object.keys(changes).length > 0;
    if (trial) {
      const profile = await this.load(project.id);
      adapter = this.factory.buildWith(project.platform, this.merge(fields, this.stored(profile, project.platform), changes!));
      source = 'unsaved';
    } else {
      source = await this.factory.sourceFor(project);
      adapter = await this.factory.forProject(project);
    }
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const connected = await Promise.race([
        adapter.healthCheck(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), TEST_TIMEOUT_MS);
        }),
      ]);
      return { source, connected, latencyMs: Date.now() - start, message: connected ? null : `The database did not answer the health check within ${TEST_TIMEOUT_MS / 1000} s.` };
    } catch (e) {
      const safe = scrub((e as Error)?.message ?? String(e));
      this.logger.warn(`Connection test failed for project ${project.id}: ${safe}`);
      return { source, connected: false, latencyMs: Date.now() - start, message: safe };
    } finally {
      if (timer) clearTimeout(timer);
      if (trial) {
        try {
          await (adapter as { onModuleDestroy?: () => Promise<void> }).onModuleDestroy?.();
        } catch {
          // A trial connection that will not close cleanly is dropped anyway.
        }
      }
    }
  }
}
