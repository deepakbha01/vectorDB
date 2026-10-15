import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmClientService, readLlmSettings } from './llm-client.service';

const configWith = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;

const okJson = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

describe('readLlmSettings', () => {
  it('is null without a known provider, a model, or a key', () => {
    expect(readLlmSettings(configWith({}))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'cohere', LLM_MODEL: 'm', LLM_API_KEY: 'k' }))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' }))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o' }))).toBeNull();
  });

  it('needs an endpoint for Azure OpenAI', () => {
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'azure-openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'k' }))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'azure-openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'k', LLM_BASE_URL: 'https://x.openai.azure.com/' }))?.baseUrl).toBe('https://x.openai.azure.com');
  });

  it('allows a keyless OpenAI-compatible local server and falls back to default limits', () => {
    const s = readLlmSettings(configWith({ LLM_PROVIDER: 'OpenAI', LLM_MODEL: 'llama3', LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MAX_OUTPUT_TOKENS: 'lots' }));
    expect(s).toMatchObject({ provider: 'openai', apiKey: '', maxOutputTokens: 1200, timeoutMs: 60000 });
  });
});

describe('LlmClientService', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('refuses when no LLM is configured', async () => {
    await expect(new LlmClientService(configWith({})).complete('s', 'u')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls Azure OpenAI by deployment with the api-key header', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: ' Summary ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const client = new LlmClientService(configWith({ LLM_PROVIDER: 'azure-openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'secret', LLM_BASE_URL: 'https://x.openai.azure.com' }));
    const out = await client.complete('sys', 'usr');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
    expect(init.headers['api-key']).toBe('secret');
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }], max_completion_tokens: 1200 });
    expect(out).toEqual({ text: 'Summary', truncated: false, usage: { inputTokens: 10, outputTokens: 5 }, provider: 'azure-openai', model: 'gpt-4o' });
  });

  it('sends max_tokens and no auth header to a keyless compatible server', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }));
    const out = await new LlmClientService(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'llama3', LLM_BASE_URL: 'http://localhost:11434/v1' })).complete('s', 'u');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body).max_tokens).toBe(1200);
    expect(out.truncated).toBe(true);
    expect(out.usage).toBeNull();
  });

  it('calls the Anthropic Messages API with the system prompt separate', async () => {
    fetchMock.mockResolvedValue(okJson({ content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }));
    const out = await new LlmClientService(configWith({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-sonnet-5-5', LLM_API_KEY: 'secret' })).complete('sys', 'usr');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
    expect(JSON.parse(init.body)).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 1200, system: 'sys', messages: [{ role: 'user', content: 'usr' }] });
    expect(out.text).toBe('Part one. Part two.');
  });

  it('reports provider errors without the key', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: { message: 'Invalid API key' } }) });
    const client = new LlmClientService(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'secret' }));
    const err = await client.complete('s', 'u').catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).toBe('The LLM provider (openai) returned 401: Invalid API key');
    expect(err.message).not.toContain('secret');
  });

  it('treats an empty answer as an error', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: '' } }] }));
    const client = new LlmClientService(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'k' }));
    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
