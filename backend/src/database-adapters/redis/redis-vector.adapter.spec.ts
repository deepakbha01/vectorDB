import { BadRequestException } from '@nestjs/common';
import { RedisVectorAdapter } from './redis-vector.adapter';

const multiInstance = { hSet: jest.fn().mockReturnThis(), exec: jest.fn() };
const mockClientInstance = {
  isOpen: true,
  connect: jest.fn(),
  quit: jest.fn(),
  on: jest.fn(),
  ping: jest.fn(),
  ft: { create: jest.fn(), search: jest.fn(), dropIndex: jest.fn() },
  multi: jest.fn(() => multiInstance),
  del: jest.fn(),
};

jest.mock('redis', () => ({
  createClient: jest.fn(() => mockClientInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_REDIS_URL: 'redis://localhost:6379', ...values };
  return { get: (key: string) => defaults[key] };
}

describe('RedisVectorAdapter', () => {
  let adapter: RedisVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClientInstance.isOpen = true;
    adapter = new RedisVectorAdapter(configService() as any);
  });

  it('reports unhealthy without throwing when no target URL is configured', async () => {
    const unconfigured = new RedisVectorAdapter(configService({ TARGET_REDIS_URL: undefined }) as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy when PING returns PONG', async () => {
    mockClientInstance.ping.mockResolvedValue('PONG');
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema declares an HNSW vector field with the right dimension and a TAG/NUMERIC per metadata type', async () => {
    mockClientInstance.ft.create.mockResolvedValue('OK');
    await adapter.createSchema({
      collectionOrTableName: 'docs',
      dimension: 768,
      metadataFields: [{ name: 'source_url', type: 'string' }, { name: 'page', type: 'number' }],
    });
    expect(mockClientInstance.ft.create).toHaveBeenCalledWith(
      'docs_idx',
      expect.objectContaining({
        embedding: { type: 'VECTOR', ALGORITHM: 'HNSW', TYPE: 'FLOAT32', DIM: 768, DISTANCE_METRIC: 'COSINE' },
        source_url: 'TAG',
        page: 'NUMERIC',
      }),
      { ON: 'HASH', PREFIX: 'docs:' },
    );
  });

  it('upsert stores the vector as a little-endian float32 buffer under the "<collection>:<id>" key', async () => {
    multiInstance.exec.mockResolvedValue([]);
    await adapter.upsert('docs', [{ id: '1', vector: [1, 2], metadata: { source_url: 'https://a' } }]);
    expect(multiInstance.hSet).toHaveBeenCalledWith('docs:1', expect.objectContaining({ id: '1', source_url: 'https://a' }));
    const buf: Buffer = multiInstance.hSet.mock.calls[0][1].embedding;
    expect(buf.readFloatLE(0)).toBeCloseTo(1);
    expect(buf.readFloatLE(4)).toBeCloseTo(2);
  });

  it('search strips the "<collection>:" prefix from returned ids and inverts distance into a similarity score', async () => {
    mockClientInstance.ft.search.mockResolvedValue({ documents: [{ id: 'docs:1', value: { id: '1', embedding: Buffer.alloc(4), score: '0.2', source_url: 'https://a' } }] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.8, metadata: { source_url: 'https://a' } }]);
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockClientInstance.ft.dropIndex).not.toHaveBeenCalled();
  });

  it('dropSchema drops the index and its documents when confirmed', async () => {
    mockClientInstance.ft.dropIndex.mockResolvedValue('OK');
    await adapter.dropSchema('docs', true);
    expect(mockClientInstance.ft.dropIndex).toHaveBeenCalledWith('docs_idx', { DD: true });
  });
});
