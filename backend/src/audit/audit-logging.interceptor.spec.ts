import { of, throwError } from 'rxjs';
import { AuditLoggingInterceptor } from './audit-logging.interceptor';

function makeContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

describe('AuditLoggingInterceptor', () => {
  let entries: { create: jest.Mock; save: jest.Mock };
  let interceptor: AuditLoggingInterceptor;

  beforeEach(() => {
    entries = { create: jest.fn((data) => data), save: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditLoggingInterceptor(entries as any);
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('does not persist anything for GET requests', async () => {
    const request = { method: 'GET', url: '/api/projects/p1', params: { id: 'p1' }, body: {} };
    const handler = { handle: () => of({ ok: true }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    expect(entries.save).not.toHaveBeenCalled();
  });

  it('persists an entry for a mutating request, resolving the project from :projectId', async () => {
    const request = {
      method: 'POST',
      url: '/api/projects/p1/discovery/assessments',
      params: { projectId: 'p1' },
      body: { estimatedVectorCount: 100 },
      user: { id: 'u1', email: 'a@b.com' },
    };
    const handler = { handle: () => of({ decision: 'postgres_pgvector' }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    expect(entries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        project: { id: 'p1' },
        userEmail: 'a@b.com',
        method: 'POST',
        statusCode: 200,
      }),
    );
  });

  it('keeps record contents and query vectors out of the audit entry for a Data Explorer search', async () => {
    const request = {
      method: 'POST',
      url: '/api/projects/p1/data-explorer/collections/docs/search',
      params: { projectId: 'p1' },
      body: { vector: [0.1, 0.2, 0.3], topK: 5, filter: { dept: 'legal' } },
      user: { id: 'u1', email: 'a@b.com' },
    };
    const handler = { handle: () => of({ results: [{ id: 'x', score: 0.9, metadata: { ssn: '123-45-6789' } }], latencyMs: 12 }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    const saved = entries.save.mock.calls[0][0];
    expect(saved.requestSummary).toEqual({ vector: '3 dimensions', topK: 5, filter: { dept: 'legal' } });
    expect(saved.responseSummary).toEqual({ results: 1, latencyMs: 12 });
    expect(JSON.stringify(saved)).not.toContain('123-45-6789');
  });

  it('resolves the project ID from the response body when creating a project', async () => {
    const request = { method: 'POST', url: '/api/projects', params: {}, body: { name: 'New Project' }, user: { id: 'u1', email: 'a@b.com' } };
    const handler = { handle: () => of({ id: 'new-project-id' }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    expect(entries.save).toHaveBeenCalledWith(expect.objectContaining({ project: { id: 'new-project-id' } }));
  });

  it('logs a null project for requests not scoped to any project (e.g. auth)', async () => {
    const request = { method: 'POST', url: '/api/auth/login', params: {}, body: { email: 'a@b.com', password: 'secret' } };
    const handler = { handle: () => of({ accessToken: 'jwt' }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    expect(entries.save).toHaveBeenCalledWith(expect.objectContaining({ project: undefined }));
  });

  it('redacts the password in the persisted request summary', async () => {
    const request = { method: 'POST', url: '/api/auth/login', params: {}, body: { email: 'a@b.com', password: 'secret' } };
    const handler = { handle: () => of({ accessToken: 'jwt' }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    const saved = entries.save.mock.calls[0][0];
    expect(saved.requestSummary.password).toBe('[REDACTED]');
    expect(saved.responseSummary.accessToken).toBe('[REDACTED]');
  });

  it('records a failed request with its error status code', async () => {
    const request = { method: 'POST', url: '/api/projects/p1/deployment/execute', params: { projectId: 'p1' }, body: {} };
    const handler = { handle: () => throwError(() => ({ status: 400, message: 'target unreachable' })) };

    await new Promise((resolve) => {
      interceptor.intercept(makeContext(request), handler as any).subscribe({ error: resolve });
    });
    await flush();

    expect(entries.save).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('never throws even if persisting the audit entry itself fails', async () => {
    entries.save.mockRejectedValue(new Error('db unavailable'));
    const request = { method: 'POST', url: '/api/projects/p1/x', params: { projectId: 'p1' }, body: {} };
    const handler = { handle: () => of({ ok: true }) };

    const result = await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    expect(result).toEqual({ ok: true });
  });

  it('records a project deletion without linking the deleted project, keeping its id and name', async () => {
    const request = { method: 'DELETE', url: '/api/projects/p1', params: { id: 'p1' }, body: {}, user: { id: 'u1', email: 'a@b.com' } };
    const handler = { handle: () => of({ id: 'p1', name: 'RAG Assistant', deleted: true }) };

    await new Promise((resolve) => interceptor.intercept(makeContext(request), handler as any).subscribe(resolve));
    await flush();

    expect(entries.save).toHaveBeenCalledWith(expect.objectContaining({ project: undefined, method: 'DELETE', path: '/api/projects/p1' }));
    expect(JSON.stringify(entries.save.mock.calls[0][0].responseSummary)).toContain('RAG Assistant');
  });
});
