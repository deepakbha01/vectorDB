/**
 * First-admin bootstrap against a real Postgres (a throwaway schema built from
 * the migrations): creation, never touching an existing admin, never taking
 * over an existing account, the secret-file option, and replicas starting at
 * once. Needs APP_DB_* (see .env); run with `npm run test:e2e -- admin-bootstrap`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source';
import { AdminBootstrapService } from '../src/users/admin-bootstrap.service';

config({ path: path.join(__dirname, '../.env') });
const SCHEMA = `it_bootstrap_${process.pid}`;
let ds: DataSource;

const bootstrap = (env: Record<string, string>) => new AdminBootstrapService({ get: (k: string) => env[k] } as unknown as ConfigService, ds);
const admins = async () => ds.query(`SELECT email, "passwordHash", "fullName", role FROM users WHERE role = 'admin'`);
const reset = () => ds.query('DELETE FROM audit_log_entries; DELETE FROM users;');
const PASSWORD = 'a-long-first-admin-secret';

beforeAll(async () => {
  const opts = { ...(AppDataSource.options as any) };
  const boot = new DataSource({ ...opts, entities: [], migrations: [] });
  await boot.initialize();
  await boot.query(`CREATE SCHEMA "${SCHEMA}"`);
  await boot.destroy();
  ds = new DataSource({ ...opts, schema: SCHEMA, extra: { options: `-c search_path=${SCHEMA},public` } });
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });
}, 120_000);

afterAll(async () => {
  if (ds?.isInitialized) {
    await ds.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await ds.destroy();
  }
});

beforeEach(reset);

it('does nothing, and says so, when no email is configured', async () => {
  await expect(bootstrap({}).run()).resolves.toBe('not-configured');
  expect(await admins()).toEqual([]);
});

it('creates the first admin with a bcrypt hash, and records it in the audit log without the password', async () => {
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD, BOOTSTRAP_ADMIN_NAME: 'Platform Ops' }).run()).resolves.toBe('created');
  const [admin] = await admins();
  expect(admin).toEqual(expect.objectContaining({ email: 'ops@aventra.example', fullName: 'Platform Ops', role: 'admin' }));
  expect(await bcrypt.compare(PASSWORD, admin.passwordHash)).toBe(true);
  const [entry] = await ds.query(`SELECT method, path, "userEmail", "requestSummary" FROM audit_log_entries`);
  expect(entry).toEqual(expect.objectContaining({ method: 'SYSTEM', path: 'bootstrap/first-admin', userEmail: 'ops@aventra.example' }));
  expect(JSON.stringify(entry)).not.toContain(PASSWORD);
});

it('never changes anything once an admin exists - not even with a new password configured', async () => {
  await bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }).run();
  const [before] = await admins();
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'other@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: 'a-different-password-here' }).run()).resolves.toBe('admin-exists');
  // A missing password does not matter either: nothing is read once an admin exists.
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example' }).run()).resolves.toBe('admin-exists');
  expect(await admins()).toEqual([before]);
});

it('refuses to take over an existing non-admin account with the same email (any case)', async () => {
  await ds.query(`INSERT INTO users (email, "passwordHash", role) VALUES ('Ops@Aventra.example', 'x', 'architect')`);
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }).run()).rejects.toThrow(/will not take over an existing account/);
  expect(await admins()).toEqual([]);
});

it('stops start-up on a missing, short or placeholder password, or a bad email', async () => {
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example' }).run()).rejects.toThrow(/no password was given/);
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: 'short' }).run()).rejects.toThrow(/at least 12/);
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: 'Administrator' }).run()).rejects.toThrow(/placeholder/);
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }).run()).rejects.toThrow(/not an email address/);
  expect(await admins()).toEqual([]);
});

it('reads the password from a secret file, ignoring its trailing newline', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-')), 'admin-password');
  fs.writeFileSync(file, `${PASSWORD}\n`);
  try {
    await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD_FILE: file, BOOTSTRAP_ADMIN_PASSWORD: 'ignored-when-a-file-is-given' }).run()).resolves.toBe('created');
    expect(await bcrypt.compare(PASSWORD, (await admins())[0].passwordHash)).toBe(true);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  await reset();
  await expect(bootstrap({ BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD_FILE: file }).run()).rejects.toThrow(/could not be read/);
});

it('creates exactly one admin when several replicas start at once', async () => {
  const env = { BOOTSTRAP_ADMIN_EMAIL: 'ops@aventra.example', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD };
  const outcomes = await Promise.all([bootstrap(env).run(), bootstrap(env).run(), bootstrap(env).run()]);
  expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
  expect(outcomes.filter((o) => o === 'admin-exists')).toHaveLength(2);
  expect(await admins()).toHaveLength(1);
});
