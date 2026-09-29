import { BadRequestException } from '@nestjs/common';
import { ChromaVectorAdapter } from './chroma-vector.adapter';

const mockCollectionInstance = {
  upsert: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  modify: jest.fn(),
  count: jest.fn(),
};

const mockClientInstance = {
  heartbeat: jest.fn(),
  createCollection: jest.fn(),
  getOrCreateCollection: jest.fn(),
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

  it('createSchema disables the default embedding function, sets cosine space, and reuses an existing collection', async () => {
    mockClientInstance.getOrCreateCollection.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockClientInstance.getOrCreateCollection).toHaveBeenCalledWith({ name: 'docs', embeddingFunction: null, metadata: { 'hnsw:space': 'cosine' } });
    expect(mockClientInstance.createCollection).not.toHaveBeenCalled();
  });

  it('upsert maps records to Chroma parallel-array {ids, embeddings, metadatas}', async () => {
    mockCollectionInstance.upsert.mockResolvedValue(undefined);
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockCollectionInstance.upsert).toHaveBeenCalledWith({ ids: ['1'], embeddings: [[0.1, 0.2]], metadatas: [{ source_url: 'https://a' }] });
  });

  it('upsert sends null for records without metadata (Chroma rejects {}), and no metadatas when none have any', async () => {
    mockCollectionInstance.upsert.mockResolvedValue(undefined);
    await adapter.upsert('docs', [
      { id: '1', vector: [0.1], metadata: { a: 1 } },
      { id: '2', vector: [0.2], metadata: {} },
    ]);
    expect(mockCollectionInstance.upsert).toHaveBeenLastCalledWith({ ids: ['1', '2'], embeddings: [[0.1], [0.2]], metadatas: [{ a: 1 }, null] });
    await adapter.upsert('docs', [{ id: '3', vector: [0.3], metadata: {} }]);
    expect(mockCollectionInstance.upsert).toHaveBeenLastCalledWith({ ids: ['3'], embeddings: [[0.3]] });
  });

  it('upsert stores json metadata (objects, arrays of objects) as JSON text - Chroma takes only scalars and flat arrays', async () => {
    mockCollectionInstance.upsert.mockResolvedValue(undefined);
    await adapter.upsert('docs', [
      { id: '1', vector: [0.1], metadata: { a: 'x', n: 2, ok: true, none: null, tags: ['p', 'q'], obj: { section: 1 }, rows: [{ r: 1 }] } },
    ]);
    expect(mockCollectionInstance.upsert).toHaveBeenLastCalledWith({
      ids: ['1'],
      embeddings: [[0.1]],
      metadatas: [{ a: 'x', n: 2, ok: true, none: null, tags: ['p', 'q'], obj: '{"section":1}', rows: '[{"r":1}]' }],
    });
  });

  it('search converts distances to scores and defaults missing metadata to {}', async () => {
    mockCollectionInstance.query.mockResolvedValue({ ids: [['1', '2']], distances: [[0.1, 0.4]], metadatas: [[{ a: 1 }, null]] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 2 });
    expect(results).toEqual([
      { id: '1', score: 0.9, metadata: { a: 1 } },
      { id: '2', score: 0.6, metadata: {} },
    ]);
  });

  describe('createVectorIndex', () => {
    const params = [
      { name: 'M', value: 24, description: '' },
      { name: 'efConstruction', value: 200, description: '' },
      { name: 'efSearch', value: 180, description: '' },
    ];

    it('re-creates an empty collection with the full HNSW configuration (build parameters are creation-only in Chroma 1.x)', async () => {
      mockCollectionInstance.count.mockResolvedValue(0);
      await adapter.createVectorIndex('docs', 'hnsw' as any, params, 'euclidean' as any);
      expect(mockClientInstance.deleteCollection).toHaveBeenCalledWith({ name: 'docs' });
      expect(mockClientInstance.createCollection).toHaveBeenCalledWith({
        name: 'docs',
        embeddingFunction: null,
        configuration: { hnsw: { space: 'l2', ef_construction: 200, max_neighbors: 24, ef_search: 180 } },
      });
      expect(mockCollectionInstance.modify).not.toHaveBeenCalled();
    });

    it('never drops a collection that holds data - only ef_search changes', async () => {
      mockCollectionInstance.count.mockResolvedValue(5);
      await adapter.createVectorIndex('docs', 'hnsw' as any, params);
      expect(mockClientInstance.deleteCollection).not.toHaveBeenCalled();
      expect(mockCollectionInstance.modify).toHaveBeenCalledWith({ configuration: { hnsw: { ef_search: 180 } } });
    });
  });

  it('search applies a requested efSearch once per value, shared by parallel searches', async () => {
    mockCollectionInstance.query.mockResolvedValue({ ids: [[]], distances: [[]], metadatas: [[]] });
    mockCollectionInstance.modify.mockResolvedValue(undefined);
    await Promise.all([1, 2, 3].map(() => adapter.search('docs', { vector: [0.1], topK: 1, searchParams: { efSearch: 50 } })));
    expect(mockCollectionInstance.modify).toHaveBeenCalledTimes(1);
    expect(mockCollectionInstance.modify).toHaveBeenCalledWith({ configuration: { hnsw: { ef_search: 50 } } });
    await adapter.search('docs', { vector: [0.1], topK: 1, searchParams: { efSearch: 100 } });
    expect(mockCollectionInstance.modify).toHaveBeenLastCalledWith({ configuration: { hnsw: { ef_search: 100 } } });
    await adapter.search('docs', { vector: [0.1], topK: 1 });
    expect(mockCollectionInstance.modify).toHaveBeenCalledTimes(2); // no efSearch asked: setting left alone
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
