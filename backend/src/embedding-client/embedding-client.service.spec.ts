import { EmbeddingClientService } from './embedding-client.service';

function configService(values: Record<string, any> = {}) {
  return { get: (key: string) => values[key] };
}

describe('EmbeddingClientService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('produces a deterministic vector of the requested dimension when no API key is configured', async () => {
    const service = new EmbeddingClientService(configService() as any);
    const result = await service.embed({ providerId: 'openai', modelId: 'text-embedding-3-small', dimension: 8, text: 'hello world' });
    expect(result.isLiveProvider).toBe(false);
    expect(result.vector).toHaveLength(8);
  });

  it('is deterministic - the same text always yields the same offline vector', async () => {
    const service = new EmbeddingClientService(configService() as any);
    const a = await service.embed({ providerId: 'openai', modelId: 'm', dimension: 16, text: 'same text' });
    const b = await service.embed({ providerId: 'openai', modelId: 'm', dimension: 16, text: 'same text' });
    expect(a.vector).toEqual(b.vector);
  });

  it('produces different vectors for different text', async () => {
    const service = new EmbeddingClientService(configService() as any);
    const a = await service.embed({ providerId: 'openai', modelId: 'm', dimension: 16, text: 'text one' });
    const b = await service.embed({ providerId: 'openai', modelId: 'm', dimension: 16, text: 'text two' });
    expect(a.vector).not.toEqual(b.vector);
  });

  it('returns a unit-length (normalized) offline vector', async () => {
    const service = new EmbeddingClientService(configService() as any);
    const { vector } = await service.embed({ providerId: 'openai', modelId: 'm', dimension: 32, text: 'normalize me' });
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('calls the OpenAI API for real when a key is configured, and falls back on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }) as any;
    const service = new EmbeddingClientService(configService({ OPENAI_API_KEY: 'sk-test' }) as any);
    const result = await service.embed({ providerId: 'openai', modelId: 'text-embedding-3-small', dimension: 3, text: 'hi' });
    expect(result.isLiveProvider).toBe(true);
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(global.fetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', expect.objectContaining({ method: 'POST' }));
  });

  it('falls back to the offline vector when the OpenAI call fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }) as any;
    const service = new EmbeddingClientService(configService({ OPENAI_API_KEY: 'sk-test' }) as any);
    const result = await service.embed({ providerId: 'openai', modelId: 'text-embedding-3-small', dimension: 4, text: 'hi' });
    expect(result.isLiveProvider).toBe(false);
    expect(result.vector).toHaveLength(4);
  });

  it('never calls a live provider for non-OpenAI providers', async () => {
    global.fetch = jest.fn();
    const service = new EmbeddingClientService(configService({ OPENAI_API_KEY: 'sk-test' }) as any);
    const result = await service.embed({ providerId: 'cohere', modelId: 'embed-english-v3.0', dimension: 4, text: 'hi' });
    expect(result.isLiveProvider).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
