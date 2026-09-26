import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogEntry } from '../../audit/audit-log-entry.entity';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';

/** Reads that reach individual requests or a tenant's usage. Aggregate dashboard reads are not audited. */
export const AUDITED_READ = /\/token-observability\/(requests|traces\/[^/?]+)(\?|$)/;

/**
 * Audits access to request-level and tenant-level usage (spec §18). The
 * global audit interceptor skips GET requests; this adds the reads that show
 * individual requests or one tenant, recording who asked and how many rows
 * came back - never the rows themselves.
 */
@Injectable()
export class UsageReadAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(@InjectRepository(AuditLogEntry) private readonly entries: Repository<AuditLogEntry>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const audited = req.method === 'GET' && (AUDITED_READ.test(req.originalUrl ?? req.url) || !!req.query?.tenant);
    if (!audited) return next.handle();
    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: (body) => void this.record(req, 200, body, start),
        error: (err) => void this.record(req, err?.status ?? 500, undefined, start),
      }),
    );
  }

  private async record(req: { originalUrl?: string; url: string; params: Record<string, string>; query: Record<string, unknown>; user?: { id: string; email: string } }, statusCode: number, body: unknown, start: number) {
    const path = req.originalUrl ?? req.url;
    const rows = body && typeof body === 'object' ? ((body as { rows?: unknown[] }).rows?.length ?? (body as { spans?: number }).spans ?? null) : null;
    this.logger.log(`user=${req.user?.email ?? 'anonymous'} action=READ_USAGE path=${path} status=${statusCode} rows=${rows ?? 'n/a'}`);
    try {
      await this.entries.save(
        this.entries.create({
          project: req.params?.projectId ? ({ id: req.params.projectId } as Project) : undefined,
          user: req.user ? ({ id: req.user.id } as User) : undefined,
          userEmail: req.user?.email,
          method: 'GET',
          path,
          statusCode,
          requestSummary: { query: req.query },
          responseSummary: rows === null ? null : { rows },
          durationMs: Date.now() - start,
        }),
      );
    } catch (e) {
      this.logger.error(`Failed to persist usage-read audit entry: ${(e as Error).message}`);
    }
  }
}
