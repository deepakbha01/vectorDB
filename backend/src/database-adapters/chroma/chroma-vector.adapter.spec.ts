import { BadRequestException } from '@nestjs/common';
import { ChromaVectorAdapter } from './chroma-vector.adapter';

const mockCollectionInstance = {
  upsert: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  modify: jest.fn(),
};

const mockClientInstance = {
  heartbeat: jest.fn(),
  createCollection: jest.fn(),
  getCollection: jest.fn(() => Promise.resolve(mockCollectionInstance)),
  deleteCollection: jest.fn(),
};

jest.mock('chromadb', () => ({
  ChromaClient: jest.fn().mockImplementation(() => mockClientInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_CHROMA_HOST: 'localhost', ...values };
  return { get: (key: string, fallback?: any) => defaults[key] ?? fallback };
}

describe('ChromaVectorAdapter', () => {
  let adapter: ChromaVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClientInstance.getCollection.mockResolvedValue(mockCollectionInstance);
    adapter = new ChromaVectorAdapter(configService() as any);
  });

  it('reports unhealthy without throwing when no target host is configured', async () => {
    const unconfigured = new ChromaVectorAdapter(configService({ TARGET_CHROMA_HOST: undefined }) as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy when heartbeat succeeds', async () => {
    mockClientInstance.heartbeat.mockResolvedValue(Date.now());
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema disables the default embedding function and sets cosine space', async () => {
    mockClientInstance.createCollection.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockClientInstance.createCollection).toHaveBeenCalledWith({ name: 'docs', embeddingFunction: null, metadata: { 'hnsw:space': 'cosine' } });
  });

  it('upsert maps records to Chroma parallel-array {ids, embeddings, metadatas}', async () => {
    mockCollectionInstance.upsert.mockResolvedValue(undefined);
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockCollectionInstance.upsert).toHaveBeenCalledWith({ ids: ['1'], embeddings: [[0.1, 0.2]], metadatas: [{ source_url: 'https://a' }] });
  });

  it('search converts distances to scores and defaults missing metadata to {}', async () => {
    mockCollectionInstance.query.mockResolvedValue({ ids: [['1', '2']], distances: [[0.1, 0.4]], metadatas: [[{ a: 1 }, null]] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 2 });
    expect(results).toEqual([
      { id: '1', score: 0.9, metadata: { a: 1 } },
      { id: '2', score: 0.6, metadata: {} },
    ]);
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockClientInstance.deleteCollection).not.toHaveBeenCalled();
  });

  it('dropSchema calls deleteCollection when confirmed', async () => {
    mockClientInstance.deleteCollection.mockResolvedValue(undefined);
    await adapter.dropSchema('docs', true);
    expect(mockClientInstance.deleteCollection).toHaveBeenCalledWith({ name: 'docs' });
  });
});
