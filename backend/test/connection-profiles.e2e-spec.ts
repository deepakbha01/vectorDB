/**
 * Per-project connection profiles against a real Postgres (the table built by
 * the migrations in a throwaway schema) and a real embedded LanceDB target:
 * a project saved with its own LanceDB folder is served from that folder,
 * while the server's settings point elsewhere. Needs APP_DB_* (see .env);
 * run with `npm run test:e2e -- connection-profiles`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source';
import { UserRole } from '../src/users/user.entity';
import { VectorPlatform } from '../src/projects/enums/platform.enum';
import { ProjectConnectionProfile } from '../src/database-adapters/connection/project-connection-profile.entity';
import { VectorAdapterFactory } from '../src/database-adapters/vector-adapter.factory';
import { LanceDbVectorAdapter } from '../src/database-adapters/lancedb/lancedb-vector.adapter';
import { ConnectionProfilesService } from '../src/connection-profiles/connection-profiles.service';
import { SimilarityMetric } from '../src/discovery/enums/discovery.enum';

config({ path: path.join(__dirname, '../.env') });
const SCHEMA = `it_conn_${process.pid}`;

const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-server-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-project-'));
const key = randomBytes(32).toString('hex');
const env: Record<string, string> = { CONNECTION_SECRET_KEY: key, TARGET_LANCEDB_URI: serverDir };
const serverConfig = { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;

let ds: DataSource;
let factory: VectorAdapterFactory;
let service: ConnectionProfilesService;
let project: { id: string; platform: VectorPlatform };
const names = async () => (await factory.forProject(project) as unknown as LanceDbVectorAdapter).listCollections();
const architect = { id: '', email: 'it@local', role: UserRole.ARCHITECT };

beforeAll(async () => {
  const opts = { ...(AppDataSource.options as any) };
  const bootstrap = new DataSource({ ...opts, entities: [], migrations: [] });
  await bootstrap.initialize();
  await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
  await bootstrap.destroy();
  ds = new DataSource({ ...opts, schema: SCHEMA, extra: { options: `-c search_path=${SCHEMA},public` } });
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });
  const [u] = await ds.query(`INSERT INTO users (email, "passwordHash", role) VALUES ('it@local', 'x', 'architect') RETURNING id`);
  const [p] = await ds.query(`INSERT INTO projects (name, "ownerId", platform) VALUES ('IT project', $1, 'lancedb') RETURNING id`, [u.id]);
  architect.id = u.id;
  project = { id: p.id, platform: VectorPlatform.LANCEDB };

  const serverLance = new LanceDbVectorAdapter(serverConfig);
  const args: any[] = Array(12).fill({});
  args[10] = serverLance;
  factory = new VectorAdapterFactory(...(args as [any, any, any, any, any, any, any, any, any, any, any, any]), {} as any, serverConfig, ds.getRepository(ProjectConnectionProfile));
  service = new ConnectionProfilesService({ findOne: async () => project } as any, factory, ds.getRepository(ProjectConnectionProfile));

  // Different tables in the two folders, so it is clear which one answered.
  await serverLance.createSchema({ collectionOrTableName: 'server_docs', dimension: 3, metric: SimilarityMetric.COSINE, metadataFields: [] as any });
  const projectLance = new LanceDbVectorAdapter({ get: (k: string) => (k === 'TARGET_LANCEDB_URI' ? projectDir : undefined) } as unknown as ConfigService);
  await projectLance.createSchema({ collectionOrTableName: 'project_docs', dimension: 3, metric: SimilarityMetric.COSINE, metadataFields: [] as any });
}, 120_000);

afterAll(async () => {
  await factory?.onModuleDestroy();
  if (ds?.isInitialized) {
    await ds.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await ds.destroy();
  }
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

it('uses the server settings until the project has its own', async () => {
  expect((await service.get(project.id, architect)).source).toBe('server');
  expect(await names()).toEqual(['server_docs']);
});

it("saves the project's connection sealed, then serves the project from it", async () => {
  const view = await service.save(project.id, architect, { TARGET_LANCEDB_URI: projectDir });
  expect(view).toMatchObject({ source: 'project', updatedBy: 'it@local' });
  const [row] = await ds.query(`SELECT "settingsSealed", "keysSet" FROM project_connection_profiles WHERE "projectId" = $1`, [project.id]);
  expect(row.settingsSealed).not.toContain(projectDir);
  expect(row.keysSet).toEqual(['TARGET_LANCEDB_URI']);
  expect(await names()).toEqual(['project_docs']);
  expect(await service.test(project.id, architect)).toMatchObject({ source: 'project', connected: true });
});

it('tests unsaved settings without saving them', async () => {
  const r = await service.test(project.id, architect, { TARGET_LANCEDB_URI: serverDir });
  expect(r).toMatchObject({ source: 'unsaved', connected: true });
  expect(await names()).toEqual(['project_docs']);
});

it('refuses to open the profile with another key - no fall-back to the server', async () => {
  env.CONNECTION_SECRET_KEY = randomBytes(32).toString('hex');
  await ds.query(`UPDATE project_connection_profiles SET "updatedAt" = now() WHERE "projectId" = $1`, [project.id]);
  try {
    await expect(factory.forProject(project)).rejects.toThrow(/cannot be opened/);
  } finally {
    env.CONNECTION_SECRET_KEY = key;
  }
});

it('removing the profile returns the project to the server settings, and deleting the project removes it', async () => {
  await expect(service.remove(project.id, architect)).resolves.toEqual({ removed: true, source: 'server' });
  expect(await names()).toEqual(['server_docs']);
  await service.save(project.id, architect, { TARGET_LANCEDB_URI: projectDir });
  await ds.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
  expect(await ds.query(`SELECT count(*)::int AS n FROM project_connection_profiles`)).toEqual([{ n: 0 }]);
});
