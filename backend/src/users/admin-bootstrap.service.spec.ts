import * as bcrypt from 'bcrypt';
import { AdminBootstrapService, BOOTSTRAP_LOCK_KEY } from './admin-bootstrap.service';
import { UserRole } from './user.entity';

/** A minimal in-memory users table and audit log behind a fake transaction. */
function setup(env: Record<string, string>, users: Array<{ email: string; role: UserRole }> = []) {
  const table = [...users] as Array<Record<string, unknown>>;
  const audit: unknown[] = [];
  const query = jest.fn();
  const usersRepo = {
    count: jest.fn(async ({ where }: any) => table.filter((u) => u.role === where.role).length),
    createQueryBuilder: () => {
      let email = '';
      const qb = {
        where: (_: string, p: { email: string }) => ((email = p.email), qb),
        getOne: async () => table.find((u) => String(u.email).toLowerCase() === email.toLowerCase()) ?? null,
      };
      return qb;
    },
    create: (x: unknown) => x,
    save: jest.fn(async (x: Record<string, unknown>) => (table.push({ id: 'new-id', ...x }), { id: 'new-id', ...x })),
  };
  const auditRepo = { save: jest.fn(async (x: unknown) => audit.push(x)) };
  const manager = { query, getRepository: (entity: { name: string }) => (entity.name === 'User' ? usersRepo : auditRepo) };
  const dataSource = { transaction: (fn: (m: unknown) => unknown) => fn(manager) };
  const service = new AdminBootstrapService({ get: (k: string) => env[k] } as any, dataSource as any);
  return { service, table, audit, query };
}

describe('AdminBootstrapService', () => {
  const env = { BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: 'a-long-first-admin-secret' };

  it('creates the first admin under an advisory lock, hashing the password and auditing it', async () => {
    const s = setup(env);
    await expect(s.service.run()).resolves.toBe('created');
    expect(s.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    expect(s.table[0]).toEqual(expect.objectContaining({ email: 'ops@aventra.example', role: UserRole.ADMIN, fullName: 'Administrator' }));
    expect(await bcrypt.compare(env.BOOTSTRAP_ADMIN_PASSWORD, String(s.table[0].passwordHash))).toBe(true);
    expect(s.audit).toEqual([expect.objectContaining({ method: 'SYSTEM', path: 'bootstrap/first-admin', requestSummary: { email: 'ops@aventra.example', role: 'admin', passwordFrom: 'BOOTSTRAP_ADMIN_PASSWORD' } })]);
    expect(JSON.stringify(s.audit)).not.toContain(env.BOOTSTRAP_ADMIN_PASSWORD);
  });

  it('does nothing once an admin exists, and reads no settings', async () => {
    const s = setup({ BOOTSTRAP_ADMIN_EMAIL: 'x@y.z' }, [{ email: 'boss@aventra.example', role: UserRole.ADMIN }]);
    await expect(s.service.run()).resolves.toBe('admin-exists');
    expect(s.table).toHaveLength(1);
  });

  it('only warns when not configured', async () => {
    await expect(setup({}).service.run()).resolves.toBe('not-configured');
  });

  it('never takes over an existing account', async () => {
    const s = setup(env, [{ email: 'OPS@aventra.example', role: UserRole.ARCHITECT }]);
    await expect(s.service.run()).rejects.toThrow(/will not take over an existing account/);
    expect(s.table).toHaveLength(1);
  });

  it('refuses a missing, short or placeholder password', async () => {
    await expect(setup({ BOOTSTRAP_ADMIN_EMAIL: env.BOOTSTRAP_ADMIN_EMAIL }).service.run()).rejects.toThrow(/no password was given/);
    await expect(setup({ ...env, BOOTSTRAP_ADMIN_PASSWORD: 'too-short' }).service.run()).rejects.toThrow(/at least 12/);
    await expect(setup({ ...env, BOOTSTRAP_ADMIN_PASSWORD: 'ADMINISTRATOR' }).service.run()).rejects.toThrow(/placeholder/);
  });
});
