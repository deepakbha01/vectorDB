import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogEntry } from './audit-log-entry.entity';
import { summarizeForAudit } from './audit-summarize';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';

/**
 * Persists a queryable audit trail entry for every mutating request - see
 * AuditLogEntry for why this is done centrally rather than via bespoke calls
 * in each service. GET requests are not audited (nothing changed).
 *
 * The project ID is recovered from the route (`:projectId` or `:id`) when
 * present, or - for project creation, which has neither yet - from the new
 * project's `id` in the response body. Requests that touch no project
 * (auth, health) are logged with a null project.
 */
@Injectable()
export class AuditLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(@InjectRepository(AuditLogEntry) private readonly entries: Repository<AuditLogEntry>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, url, user, params, body } = request;
    const start = Date.now();

    if (method === 'GET') {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: (response) => this.record({ method, url, user, params, body, response, statusCode: 200, start }),
        error: (error) =>
          this.record({ method, url, user, params, body, response: undefined, statusCode: error?.status ?? 500, start }),
      }),
    );
  }

  private async record(input: {
    method: string;
    url: string;
    user?: { id: string; email: string };
    params: Record<string, string>;
    body: unknown;
    response: unknown;
    statusCode: number;
    start: number;
  }): Promise<void> {
    const durationMs = Date.now() - input.start;
    const projectId = this.resolveProjectId(input.url, input.method, input.params, input.response);

    this.logger.log(`user=${input.user?.email ?? 'anonymous'} action=${input.method} path=${input.url} status=${input.statusCode} durationMs=${durationMs}`);

    try {
      await this.entries.save(
        this.entries.create({
          project: projectId ? ({ id: projectId } as Project) : undefined,
          user: input.user ? ({ id: input.user.id } as User) : undefined,
          userEmail: input.user?.email,
          method: input.method,
          path: input.url,
          statusCode: input.statusCode,
          requestSummary: summarizeForAudit(input.body),
          responseSummary: summarizeForAudit(input.response),
          durationMs,
        }),
      );
    } catch (error) {
      // Never let audit persistence break the actual request - the console log above still captured it.
      this.logger.error(`Failed to persist audit log entry: ${(error as Error).message}`);
    }
  }

  private resolveProjectId(url: string, method: string, params: Record<string, string>, response: unknown): string | undefined {
    if (params.projectId) return params.projectId;
    if (params.id && url.match(/^\/api\/projects\/[^/]+$/)) return params.id;
    if (method === 'POST' && url === '/api/projects' && response && typeof response === 'object' && 'id' in response) {
      return (response as { id: string }).id;
    }
    return undefined;
  }
}
