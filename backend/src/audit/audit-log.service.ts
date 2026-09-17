import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntry } from './audit-log-entry.entity';
import { ProjectsService } from '../projects/projects.service';
import { AuthenticatedUser } from '../auth/auth.service';

const MAX_ENTRIES_PER_QUERY = 200;

@Injectable()
export class AuditLogService {
  constructor(
    @InjectRepository(AuditLogEntry) private readonly entries: Repository<AuditLogEntry>,
    private readonly projectsService: ProjectsService,
  ) {}

  async findByProject(projectId: string, requester: AuthenticatedUser): Promise<AuditLogEntry[]> {
    await this.projectsService.findOne(projectId, requester); // enforces access to this project
    return this.entries.find({
      where: { project: { id: projectId } },
      order: { createdAt: 'DESC' },
      take: MAX_ENTRIES_PER_QUERY,
    });
  }
}
