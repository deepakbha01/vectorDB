import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogEntry } from '../audit/audit-log-entry.entity';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';

/** The documents list and the embedding map - a collection that happens to be called "documents" is not a record read. */
export const DOCUMENTS_READ = /\/data-explorer\/collections\/[^/?]+\/(documents|map)(\?|$)/;

/**
 * Audits reads of record contents from a customer's vector database (the
 * documents list). The global audit interceptor already records every POST,
 * including searches; this adds the GET that returns record payloads. It
 * stores who asked, what and how many rows - never the rows.
 */
@Injectable()
export class DataExplorerReadAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(@InjectRepository(AuditLogEntry) private readonly entries: Repository<AuditLogEntry>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    if (req.method !== 'GET' || !DOCUMENTS_READ.test(req.originalUrl ?? req.url)) return next.handle();
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
    const rows = body && typeof body === 'object' ? ((body as { rows?: unknown[]; points?: unknown[] }).rows?.length ?? (body as { points?: unknown[] }).points?.length ?? null) : null;
    this.logger.log(`user=${req.user?.email ?? 'anonymous'} action=READ_VECTOR_DATA path=${path} status=${statusCode} rows=${rows ?? 'n/a'}`);
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
      this.logger.error(`Failed to persist data-explorer read audit entry: ${(e as Error).message}`);
    }
  }
}
