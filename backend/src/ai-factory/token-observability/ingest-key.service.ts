import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiIngestKey } from './ingest-key.entity';
import { generateIngestKey, matchesHash, prefixOf } from './ingest-keys';

/** Record lastUsedAt at most this often, so a busy collector does not write on every batch. */
const TOUCH_EVERY_MS = 60_000;

@Injectable()
export class IngestKeyService {
  private readonly logger = new Logger(IngestKeyService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    @InjectRepository(AiIngestKey) private readonly keys: Repository<AiIngestKey>,
  ) {}

  /** Returns the key once; it cannot be retrieved again. */
  async create(projectId: string, requester: AuthenticatedUser, name: string) {
    await this.projectsService.findOne(projectId, requester);
    const { key, prefix, hash } = generateIngestKey();
    const saved = await this.keys.save(this.keys.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, name: name.trim(), prefix, keyHash: hash, lastUsedAt: null, revokedAt: null }));
    this.logger.log(`user=${requester.email} action=create_ingest_key projectId=${projectId} key=${prefix}`);
    return { ...this.view(saved), key };
  }

  async list(projectId: string, requester: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, requester);
    const rows = await this.keys.find({ where: { project: { id: projectId } }, relations: { createdBy: true }, order: { createdAt: 'DESC' } });
    return rows.map((r) => ({ ...this.view(r), createdBy: r.createdBy?.email ?? null }));
  }

  async revoke(projectId: string, requester: AuthenticatedUser, keyId: string) {
    await this.projectsService.findOne(projectId, requester);
    const row = await this.keys.findOne({ where: { id: keyId, project: { id: projectId } } });
    if (!row) throw new NotFoundException('No such ingest key in this project.');
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      await this.keys.save(row);
      this.logger.log(`user=${requester.email} action=revoke_ingest_key projectId=${projectId} key=${row.prefix}`);
    }
    return this.view(row);
  }

  /** The project a presented key may write to, or null for an unknown, malformed or revoked key. */
  async verify(key: string, now = new Date()): Promise<{ projectId: string; keyId: string; prefix: string } | null> {
    const prefix = prefixOf(key);
    if (!prefix) return null;
    const row = await this.keys.findOne({ where: { prefix }, relations: { project: true } });
    if (!row || row.revokedAt || !matchesHash(key, row.keyHash)) return null;
    // Best effort: a stale lastUsedAt must never fail an ingest.
    if (!row.lastUsedAt || row.lastUsedAt.getTime() < now.getTime() - TOUCH_EVERY_MS) {
      this.keys.update({ id: row.id }, { lastUsedAt: now }).catch(() => undefined);
    }
    return { projectId: row.project.id, keyId: row.id, prefix };
  }

  private view(r: AiIngestKey) {
    return { id: r.id, name: r.name, prefix: r.prefix, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt };
  }
}
