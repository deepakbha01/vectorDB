import { BadRequestException } from '@nestjs/common';
import { PineconeVectorAdapter } from './pinecone-vector.adapter';

const mockIndexInstance = {
  describeIndexStats: jest.fn(),
  upsert: jest.fn(),
  query: jest.fn(),
  deleteMany: jest.fn(),
};

const mockPineconeInstance = {
  index: jest.fn(() => mockIndexInstance),
  indexes: { create: jest.fn(), delete: jest.fn() },
};

jest.mock('@pinecone-database/pinecone', () => ({
  Pinecone: jest.fn().mockImplementation(() => mockPineconeInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_PINECONE_API_KEY: 'key', TARGET_PINECONE_INDEX: 'docs', ...values };
  return { get: (key: string, fallback?: any) => defaults[key] ?? fallback };
}

describe('PineconeVectorAdapter', () => {
  let adapter: PineconeVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new PineconeVectorAdapter(configService() as any);
  });

  it('reports unhealthy without throwing when no API key is configured', async () => {
    const unconfigured = new PineconeVectorAdapter(configService({ TARGET_PINECONE_API_KEY: undefined }) as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy when describeIndexStats succeeds', async () => {
    mockIndexInstance.describeIndexStats.mockResolvedValue({});
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema converts underscores to hyphens for Pinecone index naming', async () => {
    mockPineconeInstance.indexes.create.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'my_docs', dimension: 768, metadataFields: [] });
    expect(mockPineconeInstance.indexes.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-docs', dimension: 768, metric: 'cosine' }),
    );
  });

  it('upsert maps records to Pinecone {id, values, metadata} shape', async () => {
    mockIndexInstance.upsert.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockIndexInstance.upsert).toHaveBeenCalledWith({ records: [{ id: '1', values: [0.1, 0.2], metadata: { source_url: 'https://a' } }] });
  });

  it('search maps Pinecone matches to VectorSearchResult, defaulting metadata to {}', async () => {
    mockIndexInstance.query.mockResolvedValue({ matches: [{ id: '1', score: 0.9 }] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.9, metadata: {} }]);
  });

  it('createVectorIndex is a documented no-op (Pinecone manages ANN internally)', async () => {
    await expect(adapter.createVectorIndex('docs', 'hnsw' as any, [])).resolves.toBeUndefined();
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPineconeInstance.indexes.delete).not.toHaveBeenCalled();
  });

  it('dropSchema calls indexes.delete with the hyphenated name when confirmed', async () => {
    mockPineconeInstance.indexes.delete.mockResolvedValue(undefined);
    await adapter.dropSchema('my_docs', true);
    expect(mockPineconeInstance.indexes.delete).toHaveBeenCalledWith('my-docs');
  });
});
