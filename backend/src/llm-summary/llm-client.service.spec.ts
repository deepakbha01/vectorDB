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

  it('needs a base URL for the generic compatible providers, and a key for hosted ones', () => {
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' }))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm', LLM_BASE_URL: 'http://vllm:8000/v1' }))?.protocol).toBe('openai');
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'anthropic-compatible', LLM_MODEL: 'm', LLM_API_KEY: 'k' }))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'gemini-2.5-flash' }))).toBeNull();
    expect(readLlmSettings(configWith({ LLM_PROVIDER: 'toString', LLM_MODEL: 'm', LLM_API_KEY: 'k' }))).toBeNull();
  });

  it('allows a keyless OpenAI-compatible local server and falls back to default limits', () => {
    const s = readLlmSettings(configWith({ LLM_PROVIDER: 'OpenAI', LLM_MODEL: 'llama3', LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MAX_OUTPUT_TOKENS: 'lots' }));
    expect(s).toMatchObject({ provider: 'openai', apiKey: '', maxOutputTokens: 4096, timeoutMs: 120000 });
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
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }], max_completion_tokens: 4096 });
    expect(out).toEqual({ text: 'Summary', truncated: false, usage: { inputTokens: 10, outputTokens: 5 }, provider: 'azure-openai', model: 'gpt-4o' });
  });

  it('sends max_tokens and no auth header to a keyless compatible server', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }));
    const out = await new LlmClientService(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'llama3', LLM_BASE_URL: 'http://localhost:11434/v1' })).complete('s', 'u');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body).max_tokens).toBe(4096);
    expect(out.truncated).toBe(true);
    expect(out.usage).toBeNull();
  });

  it('calls the Anthropic Messages API with the system prompt separate', async () => {
    fetchMock.mockResolvedValue(okJson({ content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }));
    const out = await new LlmClientService(configWith({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-sonnet-5-5', LLM_API_KEY: 'secret' })).complete('sys', 'usr');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
    expect(JSON.parse(init.body)).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: 'sys', messages: [{ role: 'user', content: 'usr' }] });
    expect(out.text).toBe('Part one. Part two.');
  });

  it.each([
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['deepseek', 'https://api.deepseek.com/v1/chat/completions'],
    ['xai', 'https://api.x.ai/v1/chat/completions'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
    ['together', 'https://api.together.xyz/v1/chat/completions'],
  ])('calls %s on its OpenAI-compatible endpoint with a bearer key', async (provider, url) => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: 'ok' } }] }));
    const out = await new LlmClientService(configWith({ LLM_PROVIDER: provider, LLM_MODEL: 'm', LLM_API_KEY: 'secret' })).complete('s', 'u');
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm', max_tokens: 4096 });
    expect(out.provider).toBe(provider);
  });

  it('runs Ollama locally without a key', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: 'ok' } }] }));
    await new LlmClientService(configWith({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama3.1' })).complete('s', 'u');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('sends anthropic-compatible providers the Messages API at their own URL', async () => {
    fetchMock.mockResolvedValue(okJson({ content: [{ type: 'text', text: 'ok' }] }));
    await new LlmClientService(configWith({ LLM_PROVIDER: 'anthropic-compatible', LLM_MODEL: 'm', LLM_API_KEY: 'k', LLM_BASE_URL: 'https://gateway.example/anthropic' })).complete('s', 'u');
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/anthropic/v1/messages');
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('k');
  });

  it('reports provider errors without the key', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: { message: 'Invalid API key' } }) });
    const client = new LlmClientService(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'secret' }));
    const err = await client.complete('s', 'u').catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).toBe('The LLM provider (openai) returned 401: Invalid API key');
    expect(err.message).not.toContain('secret');
  });

  const busy = (status: number, body: unknown) => ({ ok: false, status, statusText: 'Service Unavailable', json: async () => body }) as unknown as Response;
  const gemini = () => {
    const client = new LlmClientService(configWith({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'gemini-3.5-flash', LLM_API_KEY: 'k' }));
    client.retryDelaysMs = [1, 1];
    return client;
  };

  it('reads the message from Gemini errors, which come wrapped in an array', async () => {
    fetchMock.mockResolvedValue(busy(400, [{ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }]));
    await expect(gemini().complete('s', 'u')).rejects.toThrow('returned 400: API key not valid. (INVALID_ARGUMENT)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a busy provider and succeeds when it recovers', async () => {
    fetchMock.mockResolvedValueOnce(busy(503, [{ error: { message: 'high demand', status: 'UNAVAILABLE' } }])).mockResolvedValueOnce(okJson({ choices: [{ message: { content: 'ok' } }] }));
    expect((await gemini().complete('s', 'u')).text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retries and says the provider is still busy', async () => {
    fetchMock.mockResolvedValue(busy(429, { error: { message: 'rate limited' } }));
    await expect(gemini().complete('s', 'u')).rejects.toThrow('rate limited (retried; the provider is still busy');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('explains an empty answer cut off at the token limit', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: null }, finish_reason: 'length' }] }));
    await expect(gemini().complete('s', 'u')).rejects.toThrow('stopped at the 4096-token output limit');
  });

  it('treats an empty answer as an error', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: '' } }] }));
    const client = new LlmClientService(configWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o', LLM_API_KEY: 'k' }));
    await expect(client.complete('s', 'u')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
