import { lastValueFrom, of } from 'rxjs';
import { canSeeTenants } from './privacy';
import { retentionPolicy } from './retention.service';
import { AUDITED_READ, UsageReadAuditInterceptor } from './usage-read-audit.interceptor';
import { UserRole } from '../../users/user.entity';

describe('tenant visibility (spec §18)', () => {
  it('shows tenants to admins and architects only, unless opened to all', () => {
    expect(canSeeTenants(UserRole.ADMIN, 'privileged')).toBe(true);
    expect(canSeeTenants(UserRole.ARCHITECT, 'privileged')).toBe(true);
    expect(canSeeTenants(UserRole.VIEWER, 'privileged')).toBe(false);
    expect(canSeeTenants(undefined, 'privileged')).toBe(false);
    expect(canSeeTenants(UserRole.VIEWER, 'ALL')).toBe(true);
  });
});

describe('retentionPolicy', () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];

  it('defaults to 395 days of events, 1095 of hourly totals and 180 of resolved alerts', () => {
    expect(retentionPolicy(env({}))).toEqual({ eventDays: 395, rollupDays: 1095, resolvedAlertDays: 180 });
  });

  it('never keeps totals for less time than the events they summarise, and ignores nonsense', () => {
    expect(retentionPolicy(env({ TOKEN_USAGE_RETENTION_DAYS: '800', TOKEN_ROLLUP_RETENTION_DAYS: '30' }))).toMatchObject({ eventDays: 800, rollupDays: 800 });
    expect(retentionPolicy(env({ TOKEN_USAGE_RETENTION_DAYS: '0', TOKEN_ALERT_RETENTION_DAYS: 'soon' }))).toMatchObject({ eventDays: 395, resolvedAlertDays: 180 });
  });
});

describe('UsageReadAuditInterceptor', () => {
  const run = async (req: Record<string, unknown>, body: unknown) => {
    const saved: Array<Record<string, unknown>> = [];
    const repo = { create: (x: Record<string, unknown>) => x, save: async (x: Record<string, unknown>) => saved.push(x) };
    const i = new UsageReadAuditInterceptor(repo as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ params: { projectId: 'p1' }, query: {}, user: { id: 'u1', email: 'a@b' }, ...req }) }) };
    await lastValueFrom(i.intercept(ctx as never, { handle: () => of(body) }));
    await new Promise((r) => setImmediate(r));
    return saved;
  };

  it('records request-level reads with the row count, never the rows', async () => {
    const saved = await run({ method: 'GET', originalUrl: '/api/projects/p1/token-observability/requests?sort=tokens', query: { sort: 'tokens' } }, { rows: [{ secret: 1 }, { secret: 2 }] });
    expect(saved).toEqual([expect.objectContaining({ method: 'GET', path: '/api/projects/p1/token-observability/requests?sort=tokens', userEmail: 'a@b', responseSummary: { rows: 2 } })]);
    expect(JSON.stringify(saved)).not.toContain('secret');
  });

  it('records trace reads and any tenant-filtered read', async () => {
    expect(await run({ method: 'GET', originalUrl: '/api/projects/p1/token-observability/traces/abc' }, { spans: 7 })).toEqual([expect.objectContaining({ responseSummary: { rows: 7 } })]);
    expect(await run({ method: 'GET', originalUrl: '/api/projects/p1/token-observability/summary?tenant=t1', query: { tenant: 't1' } }, {})).toHaveLength(1);
  });

  it('leaves aggregate dashboard reads and writes alone (writes go to the global audit)', async () => {
    expect(await run({ method: 'GET', originalUrl: '/api/projects/p1/token-observability/summary' }, {})).toEqual([]);
    expect(await run({ method: 'POST', originalUrl: '/api/projects/p1/token-observability/requests' }, {})).toEqual([]);
  });

  it('matches only the request-level routes', () => {
    expect(AUDITED_READ.test('/api/projects/p1/token-observability/requests')).toBe(true);
    expect(AUDITED_READ.test('/api/projects/p1/token-observability/traces/t-1')).toBe(true);
    expect(AUDITED_READ.test('/api/projects/p1/token-observability/trends')).toBe(false);
  });
});
