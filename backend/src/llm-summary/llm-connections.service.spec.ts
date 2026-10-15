import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { unseal } from '../database-adapters/connection/secret-box';
import { AuthenticatedUser } from '../auth/auth.service';
import { LlmClientService } from './llm-client.service';
import { LlmConnection } from './llm-connection.entity';
import { LlmConnectionsService, SERVER_CONNECTION_ID } from './llm-connections.service';

const SECRET = '11'.repeat(32);
const admin = { id: 'u1', email: 'a@x.test', role: 'admin' } as unknown as AuthenticatedUser;

/** In-memory stand-in for the llm_connections repository. */
function setup(env: Record<string, string> = {}) {
  const rows: LlmConnection[] = [];
  let n = 0;
  const matches = (r: LlmConnection, where: Partial<LlmConnection>) => Object.entries(where).every(([k, v]) => (r as any)[k] === v);
  const save = async (c: LlmConnection) => {
    if (!c.id) {
      c.id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      c.createdAt = new Date();
      rows.push(c);
    }
    c.updatedAt = new Date();
    return c;
  };
  const repo = {
    create: (d: Partial<LlmConnection>) => ({ ...d }) as LlmConnection,
    count: async () => rows.length,
    find: async () => [...rows],
    findOne: async ({ where }: { where: Partial<LlmConnection> }) => rows.find((r) => matches(r, where)) ?? null,
    remove: async (c: LlmConnection) => rows.splice(rows.indexOf(c), 1),
  } as unknown as Repository<LlmConnection>;
  const dataSource = {
    transaction: async (fn: (m: unknown) => unknown) =>
      fn({
        update: async (_e: unknown, where: Partial<LlmConnection>, set: Partial<LlmConnection>) => rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, set)),
        save: async (_e: unknown, c: LlmConnection) => save(c),
      }),
  } as unknown as DataSource;
  const llm = { complete: jest.fn() } as unknown as LlmClientService & { complete: jest.Mock };
  const config = { get: (k: string) => ({ CONNECTION_SECRET_KEY: SECRET, ...env })[k] } as unknown as ConfigService;
  return { service: new LlmConnectionsService(config, llm, dataSource, repo), rows, llm };
}

describe('LlmConnectionsService', () => {
  it('stores the key sealed and never returns it', async () => {
    const { service, rows } = setup();
    const view = await service.create({ name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: ' sk-secret ' }, admin);
    expect(view).toMatchObject({ name: 'Claude', providerLabel: 'Anthropic (Claude)', hasApiKey: true, isDefault: true, ready: true });
    expect(JSON.stringify(view)).not.toContain('sk-secret');
    expect(rows[0].apiKeySealed).not.toContain('sk-secret');
    expect(unseal(rows[0].apiKeySealed!, Buffer.from(SECRET, 'hex'))).toBe('sk-secret');
  });

  it('refuses to store a key without CONNECTION_SECRET_KEY', async () => {
    const { service } = setup({ CONNECTION_SECRET_KEY: '' });
    await expect(service.create({ name: 'x', provider: 'openai', model: 'gpt-4o', apiKey: 'k' }, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the key when the update omits it, and clears it on an empty string', async () => {
    const { service } = setup();
    const { id } = await service.create({ name: 'OpenAI', provider: 'openai', model: 'gpt-4o', apiKey: 'k' }, admin);
    expect((await service.update(id, { model: 'gpt-4.1' }, admin)).hasApiKey).toBe(true);
    const cleared = await service.update(id, { apiKey: '' }, admin);
    expect(cleared).toMatchObject({ hasApiKey: false, ready: false });
  });

  it('keeps a single default', async () => {
    const { service } = setup();
    const a = await service.create({ name: 'A', provider: 'openai', model: 'm', apiKey: 'k' }, admin);
    const b = await service.create({ name: 'B', provider: 'mistral', model: 'm', apiKey: 'k', isDefault: true }, admin);
    const list = await service.list();
    expect(list.find((c) => c.id === a.id)?.isDefault).toBe(false);
    expect(list.find((c) => c.id === b.id)?.isDefault).toBe(true);
  });

  it('rejects base URLs that are not http(s) or that carry credentials', async () => {
    const { service } = setup();
    const base = { name: 'x', provider: 'openai-compatible', model: 'm' };
    await expect(service.create({ ...base, baseUrl: 'file:///etc/passwd' }, admin)).rejects.toThrow('https:// or http://');
    await expect(service.create({ ...base, baseUrl: 'https://user:pw@gw.example/v1' }, admin)).rejects.toThrow('API key field');
    expect((await service.create({ ...base, baseUrl: 'http://vllm:8000/v1/' }, admin)).baseUrl).toBe('http://vllm:8000/v1');
  });

  it('lists the server LLM_* settings as a read-only entry that cannot be edited', async () => {
    const { service } = setup({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-sonnet-5-5', LLM_API_KEY: 'k' });
    const [server] = await service.list();
    expect(server).toMatchObject({ id: SERVER_CONNECTION_ID, fromServerSettings: true, isDefault: true, hasApiKey: true });
    await expect(service.update(SERVER_CONNECTION_ID, { model: 'x' }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove('not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves the chosen integration, else the saved default, else the server settings', async () => {
    const { service } = setup({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-sonnet-5-5', LLM_API_KEY: 'k' });
    expect((await service.resolve()).connectionId).toBe(SERVER_CONNECTION_ID);
    const saved = await service.create({ name: 'Gemini', provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gk' }, admin);
    const def = await service.resolve();
    expect(def).toMatchObject({ connectionId: saved.id, connectionName: 'Gemini' });
    expect(def.settings).toMatchObject({ provider: 'gemini', apiKey: 'gk', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
    expect((await service.resolve(SERVER_CONNECTION_ID)).settings.provider).toBe('anthropic');
  });

  it('says how to set one up when there is none', async () => {
    await expect(setup().service.resolve()).rejects.toThrow('Settings > LLM integrations');
  });

  it('refuses an incomplete integration by name', async () => {
    const { service } = setup();
    const c = await service.create({ name: 'Azure', provider: 'azure-openai', model: 'gpt-4o', apiKey: 'k' }, admin);
    await expect(service.resolve(c.id)).rejects.toThrow('"Azure" is incomplete');
  });

  it('reports a key that no longer opens instead of sending garbage', async () => {
    const { service, rows } = setup();
    const c = await service.create({ name: 'A', provider: 'openai', model: 'm', apiKey: 'k' }, admin);
    rows[0].apiKeySealed = 'v1:bad:bad:bad';
    await expect(service.resolve(c.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('tests an integration with a tiny prompt', async () => {
    const { service, llm } = setup();
    const c = await service.create({ name: 'Groq', provider: 'groq', model: 'llama', apiKey: 'k' }, admin);
    llm.complete.mockResolvedValue({ text: 'connection OK', provider: 'groq', model: 'llama', truncated: false, usage: null });
    expect(await service.test(c.id)).toMatchObject({ ok: true, provider: 'groq', reply: 'connection OK' });
    expect(llm.complete.mock.calls[0][2]).toMatchObject({ apiKey: 'k', maxOutputTokens: 64 });
  });
});
