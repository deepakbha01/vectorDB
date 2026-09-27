import { randomBytes } from 'crypto';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { UserRole } from '../users/user.entity';
import { seal, unseal } from '../database-adapters/connection/secret-box';
import { ConnectionProfilesService } from './connection-profiles.service';
import { auditSummaries } from '../audit/audit-summarize';

const architect = { id: 'u1', email: 'a@x.io', role: UserRole.ARCHITECT };
const viewer = { id: 'u2', email: 'v@x.io', role: UserRole.VIEWER };

function setup(o: { platform?: VectorPlatform; profile?: any; key?: Buffer | null; health?: () => Promise<boolean> } = {}) {
  const key = o.key === undefined ? randomBytes(32) : o.key;
  let row = o.profile ?? null;
  const profiles = {
    findOne: jest.fn(async () => row),
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => {
      row = { ...x, updatedAt: new Date('2026-09-26T00:00:00Z') };
      return row;
    }),
    delete: jest.fn(async () => ({ affected: row ? 1 : 0 })),
  };
  const trial = { healthCheck: jest.fn(o.health ?? (async () => true)), onModuleDestroy: jest.fn() };
  const factory = {
    secretKey: () => key,
    buildWith: jest.fn(() => trial),
    forProject: jest.fn(async () => trial),
    sourceFor: jest.fn(async () => (row ? 'project' : 'server')),
  };
  const projects = { findOne: jest.fn().mockResolvedValue({ id: 'p1', platform: o.platform ?? VectorPlatform.POSTGRES_PGVECTOR }) };
  const service = new ConnectionProfilesService(projects as any, factory as any, profiles as any);
  return { service, profiles, factory, trial, key, stored: () => row };
}

describe('ConnectionProfilesService', () => {
  it('reports the server connection when the project has none', async () => {
    const { service } = setup();
    const v = await service.get('p1', viewer);
    expect(v.source).toBe('server');
    expect(v.encryptionAvailable).toBe(true);
    expect(v.fields.map((f) => f.key)).toContain('TARGET_PG_HOST');
    expect(v.fields.every((f) => !f.set)).toBe(true);
  });

  it('stores settings sealed and never returns a secret', async () => {
    const s = setup();
    const v = await s.service.save('p1', architect, { TARGET_PG_HOST: 'db.internal', TARGET_PG_PASSWORD: 'hunter2' });
    const row = s.stored();
    expect(row.settingsSealed).not.toContain('hunter2');
    expect(JSON.parse(unseal(row.settingsSealed, s.key!))).toEqual({ TARGET_PG_HOST: 'db.internal', TARGET_PG_PASSWORD: 'hunter2' });
    expect(row.keysSet).toEqual(['TARGET_PG_HOST', 'TARGET_PG_PASSWORD']);
    expect(v.source).toBe('project');
    const pw = v.fields.find((f) => f.key === 'TARGET_PG_PASSWORD')!;
    expect(pw).toMatchObject({ set: true, value: null });
    expect(v.fields.find((f) => f.key === 'TARGET_PG_HOST')!.value).toBe('db.internal');
    expect(JSON.stringify(v)).not.toContain('hunter2');
    expect(JSON.stringify(await s.service.get('p1', viewer))).not.toContain('hunter2');
  });

  it('keeps an omitted secret, clears one set to empty', async () => {
    const s = setup();
    await s.service.save('p1', architect, { TARGET_PG_HOST: 'h1', TARGET_PG_PASSWORD: 'pw' });
    await s.service.save('p1', architect, { TARGET_PG_HOST: 'h2' });
    expect(JSON.parse(unseal(s.stored().settingsSealed, s.key!))).toEqual({ TARGET_PG_HOST: 'h2', TARGET_PG_PASSWORD: 'pw' });
    await s.service.save('p1', architect, { TARGET_PG_PASSWORD: '' });
    expect(JSON.parse(unseal(s.stored().settingsSealed, s.key!))).toEqual({ TARGET_PG_HOST: 'h2' });
  });

  it('refuses unknown settings, missing required ones, non-text values and saving without a key', async () => {
    const s = setup();
    await expect(s.service.save('p1', architect, { TARGET_QDRANT_URL: 'x', TARGET_PG_HOST: 'h' })).rejects.toThrow(/not a connection setting/);
    await expect(s.service.save('p1', architect, { TARGET_PG_USER: 'u' })).rejects.toThrow(/Missing: Host/);
    await expect(s.service.save('p1', architect, { TARGET_PG_HOST: { $ne: 1 } })).rejects.toThrow(/must be text/);
    await expect(setup({ key: null }).service.save('p1', architect, { TARGET_PG_HOST: 'h' })).rejects.toThrow(/CONNECTION_SECRET_KEY/);
  });

  it('lets only admins and architects change or test it', async () => {
    const s = setup();
    await expect(s.service.save('p1', viewer, { TARGET_PG_HOST: 'h' })).rejects.toThrow(/admins and architects/);
    await expect(s.service.remove('p1', viewer)).rejects.toThrow(/admins and architects/);
    await expect(s.service.test('p1', viewer)).rejects.toThrow(/admins and architects/);
  });

  it('does not offer a connection before a platform is chosen', async () => {
    await expect(setup({ platform: VectorPlatform.UNDETERMINED }).service.get('p1', viewer)).rejects.toThrow(/no target platform/);
  });

  it('shows a profile saved for a previous platform as inactive', async () => {
    const key = randomBytes(32);
    const s = setup({ key, profile: { platform: 'qdrant', settingsSealed: seal('{"TARGET_QDRANT_URL":"http://q"}', key), keysSet: ['TARGET_QDRANT_URL'], updatedAt: new Date() } });
    const v = await s.service.get('p1', viewer);
    expect(v).toMatchObject({ source: 'server', inactiveProfileFor: 'qdrant' });
  });

  it('tests unsaved changes on a throw-away adapter over the stored settings', async () => {
    const s = setup();
    await s.service.save('p1', architect, { TARGET_PG_HOST: 'h1', TARGET_PG_PASSWORD: 'pw' });
    const r = await s.service.test('p1', architect, { TARGET_PG_HOST: 'h2' });
    expect(r).toMatchObject({ source: 'unsaved', connected: true });
    expect(s.factory.buildWith).toHaveBeenCalledWith(VectorPlatform.POSTGRES_PGVECTOR, { TARGET_PG_HOST: 'h2', TARGET_PG_PASSWORD: 'pw' });
    expect(s.trial.onModuleDestroy).toHaveBeenCalled();
  });

  it('tests the connection in use without disposing it', async () => {
    const s = setup();
    const r = await s.service.test('p1', architect);
    expect(r).toMatchObject({ source: 'server', connected: true });
    expect(s.factory.forProject).toHaveBeenCalled();
    expect(s.trial.onModuleDestroy).not.toHaveBeenCalled();
  });

  it('reports a failed test without the connection string', async () => {
    const s = setup({
      health: async () => {
        throw new Error('connect ECONNREFUSED postgres://admin:hunter2@db:5432/x');
      },
    });
    const r = await s.service.test('p1', architect, { TARGET_PG_HOST: 'db' });
    expect(r.connected).toBe(false);
    expect(r.message).not.toContain('hunter2');
    expect(r.message).toContain('[connection]');
  });

  it('removes the profile', async () => {
    const s = setup();
    await s.service.save('p1', architect, { TARGET_PG_HOST: 'h' });
    await expect(s.service.remove('p1', architect)).resolves.toEqual({ removed: true, source: 'server' });
  });
});

describe('audit of connection changes', () => {
  it('records the names of the settings, never their values', () => {
    const body = { settings: { TARGET_PG_HOST: 'db.internal', TARGET_PG_PASSWORD: 'hunter2' } };
    const reply = { source: 'project', fields: [{ key: 'TARGET_PG_HOST', set: true, value: 'db.internal' }, { key: 'TARGET_PG_PASSWORD', set: true, value: null }] };
    const s = auditSummaries('/api/projects/p1/connection', body, reply);
    expect(s.requestSummary).toEqual({ settings: ['TARGET_PG_HOST', 'TARGET_PG_PASSWORD'] });
    expect(s.responseSummary).toEqual({ source: 'project', set: ['TARGET_PG_HOST', 'TARGET_PG_PASSWORD'] });
    expect(JSON.stringify(s)).not.toMatch(/hunter2|db\.internal/);
    const t = auditSummaries('/api/projects/p1/connection/test', body, { source: 'unsaved', connected: false, latencyMs: 12, message: 'refused' });
    expect(JSON.stringify(t)).not.toMatch(/hunter2|db\.internal/);
    expect(t.responseSummary).toMatchObject({ connected: false, message: 'refused' });
  });
});
