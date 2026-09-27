import { randomBytes } from 'crypto';
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { VectorAdapterFactory } from '../vector-adapter.factory';
import { LanceDbVectorAdapter } from '../lancedb/lancedb-vector.adapter';
import { parseSecretKey, seal, unseal } from './secret-box';
import { CONNECTION_FIELDS } from './connection-fields';

describe('secret box', () => {
  const key = randomBytes(32);

  it('seals and opens a value, with a fresh IV each time', () => {
    const a = seal('{"TARGET_PG_PASSWORD":"s3cret"}', key);
    const b = seal('{"TARGET_PG_PASSWORD":"s3cret"}', key);
    expect(a).not.toEqual(b);
    expect(a).not.toContain('s3cret');
    expect(unseal(a, key)).toBe('{"TARGET_PG_PASSWORD":"s3cret"}');
  });

  it('refuses a changed byte, a wrong key and an unknown format', () => {
    const sealed = seal('hello', key);
    const [v, iv, tag, data] = sealed.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => unseal([v, iv, tag, flipped.toString('base64')].join(':'), key)).toThrow();
    expect(() => unseal(sealed, randomBytes(32))).toThrow();
    expect(() => unseal('v2:a:b:c', key)).toThrow(/Unrecognised/);
    expect(() => unseal('plain text', key)).toThrow();
  });

  it('accepts a 32-byte key as hex or base64 and nothing else', () => {
    const raw = randomBytes(32);
    expect(parseSecretKey(raw.toString('hex'))).toEqual(raw);
    expect(parseSecretKey(raw.toString('base64'))).toEqual(raw);
    expect(parseSecretKey(`  ${raw.toString('hex')}\n`)).toEqual(raw);
    expect(parseSecretKey(undefined)).toBeNull();
    expect(parseSecretKey('')).toBeNull();
    expect(parseSecretKey('too-short')).toBeNull();
    expect(parseSecretKey(randomBytes(16).toString('hex'))).toBeNull();
  });

  it('marks every credential-bearing setting secret', () => {
    const secret = Object.values(CONNECTION_FIELDS)
      .flat()
      .filter((f) => /PASSWORD|API_KEY|TOKEN|REDIS_URL|MONGODB_ATLAS_URI/.test(f.key));
    expect(secret.length).toBeGreaterThan(0);
    for (const f of secret) expect(f.secret).toBe(true);
  });
});

describe('VectorAdapterFactory.forProject', () => {
  const key = randomBytes(32);
  const project = { id: 'p1', platform: VectorPlatform.LANCEDB };

  function setup(o: { profile?: any; secretKey?: string } = {}) {
    const server = { name: 'server-lancedb' };
    const profiles = { findOne: jest.fn().mockImplementation(async () => o.profile ?? null) };
    const config = { get: (k: string) => (k === 'CONNECTION_SECRET_KEY' ? o.secretKey ?? key.toString('hex') : undefined) };
    const args: any[] = Array(12).fill({});
    args[10] = server; // lancedb
    const factory = new VectorAdapterFactory(...(args as [any, any, any, any, any, any, any, any, any, any, any, any]), {} as any, config as any, profiles as any);
    return { factory, server, profiles };
  }

  const profileWith = (settings: Record<string, string>, at = '2026-09-01T00:00:00Z', platform = 'lancedb') => ({
    platform,
    settingsSealed: seal(JSON.stringify(settings), key),
    keysSet: Object.keys(settings),
    updatedAt: new Date(at),
  });

  it('uses the server adapter when the project has no profile', async () => {
    const { factory, server } = setup();
    await expect(factory.forProject(project)).resolves.toBe(server);
    await expect(factory.sourceFor(project)).resolves.toBe('server');
  });

  it("builds a separate adapter that reads only the profile's settings", async () => {
    const { factory, server } = setup({ profile: profileWith({ TARGET_LANCEDB_URI: '/data/project-one' }) });
    const adapter = await factory.forProject(project);
    expect(adapter).not.toBe(server);
    expect(adapter).toBeInstanceOf(LanceDbVectorAdapter);
    const cfg = (adapter as any).config;
    expect(cfg.get('TARGET_LANCEDB_URI')).toBe('/data/project-one');
    // Never falls through to the server's environment.
    expect(cfg.get('TARGET_PG_PASSWORD')).toBeUndefined();
    await expect(factory.sourceFor(project)).resolves.toBe('project');
  });

  it('caches the adapter until the profile changes', async () => {
    const s = setup({ profile: profileWith({ TARGET_LANCEDB_URI: '/a' }) });
    const first = await s.factory.forProject(project);
    expect(await s.factory.forProject(project)).toBe(first);
    s.profiles.findOne.mockResolvedValue(profileWith({ TARGET_LANCEDB_URI: '/b' }, '2026-09-02T00:00:00Z'));
    const second = await s.factory.forProject(project);
    expect(second).not.toBe(first);
    expect((second as any).config.get('TARGET_LANCEDB_URI')).toBe('/b');
  });

  it('ignores a profile saved for another platform', async () => {
    const { factory, server } = setup({ profile: profileWith({ TARGET_QDRANT_URL: 'http://q' }, undefined, 'qdrant') });
    await expect(factory.forProject(project)).resolves.toBe(server);
  });

  it('refuses - never falls back to the server - when the profile cannot be opened', async () => {
    const noKey = setup({ profile: profileWith({ TARGET_LANCEDB_URI: '/a' }), secretKey: '' });
    await expect(noKey.factory.forProject(project)).rejects.toThrow(/CONNECTION_SECRET_KEY/);
    const otherKey = setup({ profile: profileWith({ TARGET_LANCEDB_URI: '/a' }), secretKey: randomBytes(32).toString('hex') });
    await expect(otherKey.factory.forProject(project)).rejects.toThrow(/cannot be opened/);
  });
});
