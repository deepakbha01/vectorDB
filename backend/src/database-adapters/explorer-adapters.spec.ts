import { QdrantVectorAdapter } from './qdrant/qdrant-vector.adapter';
import { MilvusVectorAdapter } from './milvus/milvus-vector.adapter';

/** Data Explorer methods of the Qdrant and Milvus adapters, against a mocked SDK client. */
const withClient = <T>(adapter: T, client: unknown): T => {
  (adapter as any).client = client;
  return adapter;
};

describe('Qdrant explorer', () => {
  const client = {
    getCollections: jest.fn().mockResolvedValue({ collections: [{ name: 'b' }, { name: 'a' }] }),
    getCollection: jest.fn().mockResolvedValue({
      points_count: 42,
      config: { params: { vectors: { size: 384, distance: 'Cosine' } }, hnsw_config: { m: 16, ef_construct: 100 } },
      payload_schema: { dept: { data_type: 'keyword' }, year: { data_type: 'integer' } },
    }),
    scroll: jest.fn().mockResolvedValue({ points: [{ id: 7, payload: { dept: 'legal' }, vector: [0.5, 0.25] }], next_page_offset: 8 }),
    query: jest.fn().mockResolvedValue({ points: [{ id: 'u-1', score: 0.8, payload: { dept: 'legal' } }] }),
  };
  const q = withClient(new QdrantVectorAdapter({} as any, {} as any), client);

  it('lists and describes collections', async () => {
    expect(await q.listCollections()).toEqual(['a', 'b']);
    expect(await q.describeCollection('a')).toEqual(expect.objectContaining({ recordCount: 42, dimension: 384, metric: 'cosine', fields: [{ name: 'dept', type: 'keyword' }, { name: 'year', type: 'integer' }] }));
  });

  it('scrolls with a typed cursor and a must-match filter', async () => {
    const page = await q.browse('a', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(page).toEqual({ records: [{ id: '7', metadata: { dept: 'legal' }, vectorPreview: [0.5, 0.25], dimension: 2 }], nextCursor: '8' });
    await q.browse('a', { limit: 1, cursor: '8', filter: {} });
    expect(client.scroll).toHaveBeenLastCalledWith('a', expect.objectContaining({ offset: 8 }));
    await expect(q.browse('a', { limit: 1, cursor: '{bad', filter: {} })).rejects.toThrow(/Invalid page cursor/);
  });

  it('searches with the filter applied', async () => {
    expect(await q.searchFiltered('a', { vector: [1, 0], topK: 3, filter: { dept: 'legal' } })).toEqual([{ id: 'u-1', score: 0.8, metadata: { dept: 'legal' } }]);
    expect(client.query).toHaveBeenCalledWith('a', expect.objectContaining({ limit: 3, filter: { must: [{ key: 'dept', match: { value: 'legal' } }] } }));
  });
});

describe('Milvus explorer', () => {
  const schema = {
    schema: {
      fields: [
        { name: 'id', data_type: 'VarChar', is_primary_key: true },
        { name: 'embedding', data_type: 'FloatVector', type_params: [{ key: 'dim', value: '4' }] },
        { name: 'dept', data_type: 'VarChar' },
      ],
    },
  };
  const client = {
    showCollections: jest.fn().mockResolvedValue({ data: [{ name: 'docs' }] }),
    describeCollection: jest.fn().mockResolvedValue(schema),
    getCollectionStatistics: jest.fn().mockResolvedValue({ stats: [{ key: 'row_count', value: '12' }] }),
    describeIndex: jest.fn().mockResolvedValue({ index_descriptions: [{ field_name: 'embedding', params: [{ key: 'index_type', value: 'HNSW' }, { key: 'metric_type', value: 'IP' }, { key: 'params', value: '{"M":16}' }] }] }),
    getLoadState: jest.fn().mockResolvedValue({ state: 'LoadStateLoaded' }),
    query: jest.fn().mockResolvedValue({ data: [{ id: 'a', dept: 'legal', embedding: [1, 2, 3, 4] }, { id: 'b', dept: 'hr', embedding: [4, 3, 2, 1] }] }),
    search: jest.fn().mockResolvedValue({ results: [{ id: 'a', score: 0.7, dept: 'legal' }] }),
  };
  const m = withClient(new MilvusVectorAdapter({} as any, {} as any), client);

  it('describes a collection from its schema, statistics and index', async () => {
    expect(await m.describeCollection('docs')).toEqual(expect.objectContaining({ recordCount: 12, dimension: 4, metric: 'dot_product', indexes: [expect.objectContaining({ type: 'hnsw' })], fields: [{ name: 'dept', type: 'VarChar' }] }));
  });

  it('pages by offset with an escaped filter expression', async () => {
    const page = await m.browse('docs', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ filter: 'dept == "legal"', limit: 2, offset: 0, output_fields: ['id', 'dept', 'embedding'] }));
    expect(page).toEqual({ records: [{ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [1, 2, 3, 4], dimension: 4 }], nextCursor: '1' });
    await expect(m.browse('docs', { limit: 100, cursor: '16300', filter: {} })).rejects.toThrow(/16,384 rows deep/);
  });

  it('never loads a collection - it says it is not loaded', async () => {
    client.getLoadState.mockResolvedValueOnce({ state: 'LoadStateNotLoad' });
    await expect(m.searchFiltered('docs', { vector: [1, 0, 0, 0], topK: 1, filter: {} })).rejects.toThrow(/is not loaded/);
    expect((client as any).loadCollection).toBeUndefined();
  });

  it('searches with the filter expression', async () => {
    expect(await m.searchFiltered('docs', { vector: [1, 0, 0, 0], topK: 1, filter: { dept: 'legal' } })).toEqual([{ id: 'a', score: 0.7, metadata: { dept: 'legal' } }]);
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ data: [[1, 0, 0, 0]], limit: 1, filter: 'dept == "legal"' }));
  });
});
