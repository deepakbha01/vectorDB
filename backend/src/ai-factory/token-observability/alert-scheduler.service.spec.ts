import { ConfigService } from '@nestjs/config';
import { AlertSchedulerService } from './alert-scheduler.service';

const setup = (o: { locked?: boolean; projects?: string[]; failFor?: string; slow?: boolean; env?: Record<string, string> } = {}) => {
  const queries: string[] = [];
  const qr = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return sql.includes('pg_try_advisory_lock') ? [{ locked: o.locked ?? true }] : [];
    }),
  };
  const evaluated: string[] = [];
  const alerts = {
    activeProjects: async () => o.projects ?? ['p1', 'p2', 'p3'],
    evaluateProject: async (id: string) => {
      if (o.slow) await new Promise((r) => setTimeout(r, 20));
      if (id === o.failFor) throw new Error('boom');
      evaluated.push(id);
    },
  };
  const env = { AI_FACTORY_ENABLED: 'true', TOKEN_OBSERVABILITY_ENABLED: 'true', ...o.env };
  const svc = new AlertSchedulerService(
    { get: (k: string) => env[k as keyof typeof env] } as unknown as ConfigService,
    { getTokenObservabilityCatalogue: () => ({ alerts: { evaluateEveryMinutes: 15 } }) } as never,
    alerts as never,
    { createQueryRunner: () => qr } as never,
  );
  return { svc, qr, queries, evaluated };
};

describe('AlertSchedulerService', () => {
  it('evaluates every active project and always releases the lock', async () => {
    const { svc, qr, queries, evaluated } = setup();
    expect(await svc.runOnce()).toBe(3);
    expect(evaluated).toEqual(['p1', 'p2', 'p3']);
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(qr.release).toHaveBeenCalled();
  });

  it('does nothing while another instance holds the lock', async () => {
    const { svc, evaluated } = setup({ locked: false });
    expect(await svc.runOnce()).toBe(0);
    expect(evaluated).toEqual([]);
  });

  it('keeps going when one project fails', async () => {
    const { svc, evaluated } = setup({ failFor: 'p2' });
    expect(await svc.runOnce()).toBe(2);
    expect(evaluated).toEqual(['p1', 'p3']);
  });

  it('never overlaps itself', async () => {
    const { svc } = setup({ slow: true });
    const [a, b] = await Promise.all([svc.runOnce(), svc.runOnce()]);
    expect([a, b].sort()).toEqual([0, 3]);
  });

  it('only schedules when Token Observability is on and alerts are not switched off', () => {
    const spy = jest.spyOn(global, 'setInterval');
    try {
      setup({ env: { TOKEN_ALERTS_ENABLED: 'false' } }).svc.onApplicationBootstrap();
      setup({ env: { TOKEN_OBSERVABILITY_ENABLED: 'false' } }).svc.onApplicationBootstrap();
      expect(spy).not.toHaveBeenCalled();
      const { svc } = setup();
      svc.onApplicationBootstrap();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000);
      svc.onModuleDestroy();
    } finally {
      spy.mockRestore();
    }
  });
});
