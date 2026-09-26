import { ChromaVectorAdapter } from './chroma/chroma-vector.adapter';
import { PineconeVectorAdapter } from './pinecone/pinecone-vector.adapter';
import { WeaviateVectorAdapter } from './weaviate/weaviate-vector.adapter';
import { ElasticsearchVectorAdapter } from './elasticsearch/elasticsearch-vector.adapter';
import { RedisVectorAdapter } from './redis/redis-vector.adapter';
import { MongoDbAtlasVectorAdapter } from './mongodb/mongodb-atlas-vector.adapter';
import { OracleVectorAdapter } from './oracle/oracle-vector.adapter';
import { LanceDbVectorAdapter } from './lancedb/lancedb-vector.adapter';
import { PostgresVectorAdapter } from './postgres/postgres-vector.adapter';
import { QdrantVectorAdapter } from './qdrant/qdrant-vector.adapter';
import { MilvusVectorAdapter } from './milvus/milvus-vector.adapter';
import { ActianVectorAdapter } from './actian/actian-vector.adapter';
import { isExplorable } from './vector-explorer';

/** Data Explorer methods of the phase-2 adapters, against mocked SDK clients (no servers here). */
const set = <T>(adapter: T, prop: string, value: unknown): T => {
  (adapter as any)[prop] = value;
  return adapter;
};
const cfg = {} as any;
const gen = {} as any;

describe('every live adapter can be explored', () => {
  it('all eleven live adapters implement the explorer; Actian (no Node.js driver) does not', () => {
    const live = [PostgresVectorAdapter, QdrantVectorAdapter, MilvusVectorAdapter, ChromaVectorAdapter, PineconeVectorAdapter, WeaviateVectorAdapter, ElasticsearchVectorAdapter, RedisVectorAdapter, MongoDbAtlasVectorAdapter, OracleVectorAdapter, LanceDbVectorAdapter];
    for (const A of live) expect(isExplorable(new (A as any)(cfg, gen))).toBe(true);
    expect(isExplorable(new ActianVectorAdapter() as any)).toBe(false);
  });
});

describe('Chroma explorer', () => {
  const col = {
    metadata: { 'hnsw:space': 'cosine' },
    count: jest.fn().mockResolvedValue(3),
    get: jest.fn().mockResolvedValue({ ids: ['a', 'b'], embeddings: [[0.1, 0.2], [0.3, 0.4]], metadatas: [{ dept: 'legal' }, { dept: 'hr', year: 2024 }] }),
    query: jest.fn().mockResolvedValue({ ids: [['a']], distances: [[0.25]], metadatas: [[{ dept: 'legal' }]] }),
  };
  const client = { listCollections: jest.fn().mockResolvedValue([{ name: 'b' }, { name: 'a' }]), getCollection: jest.fn().mockResolvedValue(col) };
  const c = set(new ChromaVectorAdapter(cfg), 'client', client);

  it('lists, and describes from the collection and a sample', async () => {
    expect(await c.listCollections()).toEqual(['a', 'b']);
    expect(await c.describeCollection('a')).toEqual(expect.objectContaining({ recordCount: 3, dimension: 2, metric: 'cosine', fields: [{ name: 'dept', type: 'string' }, { name: 'year', type: 'number' }] }));
  });

  it('pages by offset with a where filter, and searches with it', async () => {
    const page = await c.browse('a', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(col.get).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2, offset: 0, where: { dept: { $eq: 'legal' } } }));
    expect(page).toEqual({ records: [{ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [0.1, 0.2], dimension: 2 }], nextCursor: '1' });
    expect(await c.searchFiltered('a', { vector: [1, 0], topK: 1, filter: {} })).toEqual([{ id: 'a', score: 0.75, metadata: { dept: 'legal' } }]);
  });

  it("says when a collection sets no distance (Chroma's default is L2)", async () => {
    col.metadata = {} as any;
    const info = await c.describeCollection('a');
    expect(info.metric).toBe('euclidean');
    expect(info.notes.join(' ')).toMatch(/default is L2/);
  });
});

describe('Pinecone explorer', () => {
  const index = {
    describeIndexStats: jest.fn().mockResolvedValue({ totalRecordCount: 42 }),
    listPaginated: jest.fn().mockResolvedValue({ vectors: [{ id: 'x' }, { id: 'y' }], pagination: { next: 'tok2' } }),
    fetch: jest.fn().mockResolvedValue({ records: { x: { id: 'x', values: [1, 2], metadata: { dept: 'legal' } }, y: { id: 'y', values: [3, 4], metadata: {} } } }),
    query: jest.fn().mockResolvedValue({ matches: [{ id: 'x', score: 0.9, metadata: { dept: 'legal' } }] }),
  };
  const client = { listIndexes: jest.fn().mockResolvedValue({ indexes: [{ name: 'kb-docs' }] }), describeIndex: jest.fn().mockResolvedValue({ dimension: 2, metric: 'dotproduct', spec: { serverless: {} } }), index: () => index };
  const p = set(new PineconeVectorAdapter(cfg), 'client', client);

  it("maps the design's name to Pinecone's (hyphens) and reports a managed index", async () => {
    expect(p.designedName('kb_docs')).toBe('kb-docs');
    expect(await p.describeCollection('kb-docs')).toEqual(expect.objectContaining({ recordCount: 42, dimension: 2, metric: 'dot_product', indexes: [expect.objectContaining({ type: 'managed' })], fields: [{ name: 'dept', type: 'string' }] }));
  });

  it('pages with the list token, refuses a filtered listing, and filters search', async () => {
    expect(await p.browse('kb-docs', { limit: 2, cursor: null, filter: {} })).toEqual(expect.objectContaining({ nextCursor: 'tok2' }));
    await expect(p.browse('kb-docs', { limit: 2, cursor: null, filter: { dept: 'legal' } })).rejects.toThrow(/use Search to filter/);
    await p.searchFiltered('kb-docs', { vector: [1, 0], topK: 1, filter: { dept: 'legal' } });
    expect(index.query).toHaveBeenCalledWith(expect.objectContaining({ filter: { dept: { $eq: 'legal' } } }));
  });
});

describe('Weaviate explorer', () => {
  const byProperty = jest.fn((name: string) => ({ equal: (v: unknown) => ({ name, v }) }));
  const collection = {
    filter: { byProperty },
    config: { get: jest.fn().mockResolvedValue({ properties: [{ name: 'dept', dataType: 'text' }], vectorizers: { default: { indexType: 'hnsw', indexConfig: { distance: 'cosine' } } } }) },
    aggregate: { overAll: jest.fn().mockResolvedValue({ totalCount: 7 }) },
    query: {
      fetchObjects: jest.fn().mockResolvedValue({ objects: [{ uuid: 'u1', properties: { dept: 'legal' }, vectors: { default: [0.5, 0.5, 0.5] } }] }),
      nearVector: jest.fn().mockResolvedValue({ objects: [{ uuid: 'u1', properties: { dept: 'legal' }, metadata: { distance: 0.2 } }] }),
    },
  };
  const client = { collections: { listAll: jest.fn().mockResolvedValue([{ name: 'KbDocs' }]), use: () => collection } };
  const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', client);

  it("capitalises the design's name and describes the class", async () => {
    expect(w.designedName('kb_docs')).toBe('Kb_docs');
    expect(await w.describeCollection('KbDocs')).toEqual(expect.objectContaining({ recordCount: 7, dimension: 3, metric: 'cosine', indexes: [expect.objectContaining({ type: 'hnsw' })], fields: [{ name: 'dept', type: 'text' }] }));
  });

  it('filters by property on browse and search', async () => {
    await w.browse('KbDocs', { limit: 5, cursor: '10', filter: { dept: 'legal' } });
    expect(collection.query.fetchObjects).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 6, offset: 10, filters: { name: 'dept', v: 'legal' } }));
    expect(await w.searchFiltered('KbDocs', { vector: [1, 0, 0], topK: 1, filter: {} })).toEqual([{ id: 'u1', score: 0.8, metadata: { dept: 'legal' } }]);
  });
});

describe('Elasticsearch explorer', () => {
  const mapping = { docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 4, similarity: 'l2_norm', index_options: { type: 'int8_hnsw' } }, dept: { type: 'keyword' }, body: { type: 'text' } } } } };
  const client = {
    indices: { getMapping: jest.fn().mockResolvedValue(mapping) },
    count: jest.fn().mockResolvedValue({ count: 9 }),
    search: jest.fn().mockResolvedValue({ hits: { hits: [{ _id: 'd1', _score: 1.5, _source: { dept: 'legal', embedding: [1, 2, 3, 4] } }] } }),
  };
  const e = set(new ElasticsearchVectorAdapter(cfg, gen), 'client', client);

  it('lists indices with a dense_vector field and describes the mapping', async () => {
    client.indices.getMapping.mockResolvedValueOnce({ ...mapping, '.internal': mapping.docs, plain: { mappings: { properties: { a: { type: 'keyword' } } } } });
    expect(await e.listCollections()).toEqual(['docs']);
    expect(await e.describeCollection('docs')).toEqual(expect.objectContaining({ recordCount: 9, dimension: 4, metric: 'euclidean', indexes: [expect.objectContaining({ type: 'hnsw' })], fields: [{ name: 'dept', type: 'keyword' }, { name: 'body', type: 'text' }] }));
  });

  it('filters browse with term / match_phrase and the kNN search with the same clauses', async () => {
    const page = await e.browse('docs', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ from: 0, size: 2, query: { bool: { filter: [{ term: { dept: 'legal' } }] } } }));
    expect(page.records[0]).toEqual({ id: 'd1', metadata: { dept: 'legal' }, vectorPreview: [1, 2, 3, 4], dimension: 4 });
    await e.searchFiltered('docs', { vector: [1, 0, 0, 0], topK: 2, filter: { body: 'notice period' } });
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ knn: expect.objectContaining({ field: 'embedding', k: 2, filter: { bool: { filter: [{ match_phrase: { body: 'notice period' } }] } } }) }));
    await expect(e.browse('docs', { limit: 100, cursor: '9950', filter: {} })).rejects.toThrow(/10,000 records deep/);
  });
});

describe('Redis explorer', () => {
  const vec = Buffer.alloc(8);
  vec.writeFloatLE(0.5, 0);
  vec.writeFloatLE(-1, 4);
  const search = jest.fn().mockResolvedValue({ documents: [{ id: 'kb:a', value: { id: 'a', dept: 'legal' } }] });
  const client: any = {
    isOpen: true,
    ft: {
      _list: jest.fn().mockResolvedValue(['kb_idx', 'other']),
      info: jest.fn().mockResolvedValue({ num_docs: '5', attributes: [{ identifier: 'id', attribute: 'id', type: 'TAG' }, { identifier: 'embedding', attribute: 'embedding', type: 'VECTOR', ALGORITHM: 'HNSW', DIM: '2', DISTANCE_METRIC: 'COSINE' }, { identifier: 'dept', attribute: 'dept', type: 'TAG' }] }),
      search,
    },
    withTypeMapping: () => ({ hGet: jest.fn().mockResolvedValue(vec) }),
  };
  const r = set(new RedisVectorAdapter(cfg), 'client', client);

  it('lists <collection>_idx indexes and describes FT.INFO', async () => {
    expect(await r.listCollections()).toEqual(['kb']);
    expect(await r.describeCollection('kb')).toEqual(expect.objectContaining({ recordCount: 5, dimension: 2, metric: 'cosine', indexes: [expect.objectContaining({ type: 'hnsw' })], fields: [{ name: 'dept', type: 'TAG' }] }));
  });

  it('pages with LIMIT, filters tags, and reads the vector bytes back', async () => {
    const page = await r.browse('kb', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(search).toHaveBeenLastCalledWith('kb_idx', '@dept:{legal}', expect.objectContaining({ LIMIT: { from: 0, size: 2 } }));
    expect(page.records[0]).toEqual({ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [0.5, -1], dimension: 2 });
  });

  it('pre-filters the KNN query', async () => {
    search.mockResolvedValueOnce({ documents: [{ id: 'kb:a', value: { dept: 'legal', score: '0.1' } }] });
    expect(await r.searchFiltered('kb', { vector: [1, 0], topK: 3, filter: { dept: 'legal' } })).toEqual([{ id: 'a', score: 0.9, metadata: { dept: 'legal' } }]);
    expect(search).toHaveBeenLastCalledWith('kb_idx', '(@dept:{legal})=>[KNN 3 @embedding $BLOB AS score]', expect.anything());
  });
});

describe('MongoDB Atlas explorer', () => {
  const docs = [{ _id: 'a', dept: 'legal', embedding: [1, 2] }, { _id: 'b', dept: 'hr', embedding: [3, 4] }];
  const find = jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => docs }) }), limit: () => ({ toArray: async () => docs.map(({ embedding, ...d }) => d) }) }));
  const aggregate = jest.fn(() => ({ toArray: async () => [{ _id: 'a', dept: 'legal', score: 0.95 }] }));
  const collection = {
    listSearchIndexes: () => ({ toArray: async () => [{ name: 'kb_vector_index', type: 'vectorSearch', latestDefinition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 2, similarity: 'dotProduct' }, { type: 'filter', path: 'dept' }] } }] }),
    estimatedDocumentCount: jest.fn().mockResolvedValue(2),
    find,
    aggregate,
  };
  const db = { listCollections: () => ({ toArray: async () => [{ name: 'kb' }, { name: 'system.views' }] }), collection: () => collection };
  const m = set(new MongoDbAtlasVectorAdapter(cfg, gen), 'db', db);

  it('lists collections with a vector index and describes it', async () => {
    expect(await m.listCollections()).toEqual(['kb']);
    expect(await m.describeCollection('kb')).toEqual(expect.objectContaining({ recordCount: 2, countIsEstimate: true, dimension: 2, metric: 'dot_product', fields: [{ name: 'dept', type: 'string' }] }));
  });

  it('pages after the last _id and keeps the id type in the cursor', async () => {
    const page = await m.browse('kb', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(find).toHaveBeenLastCalledWith({ dept: { $eq: 'legal' } });
    expect(page.nextCursor).toBe(JSON.stringify({ t: 's', v: 'a' }));
    await m.browse('kb', { limit: 1, cursor: page.nextCursor, filter: {} });
    expect(find).toHaveBeenLastCalledWith({ _id: { $gt: 'a' } });
    await expect(m.browse('kb', { limit: 1, cursor: 'nonsense', filter: {} })).rejects.toThrow(/Invalid page cursor/);
  });

  it('filters search only on the index filter fields', async () => {
    expect(await m.searchFiltered('kb', { vector: [1, 0], topK: 1, filter: { dept: 'legal' } })).toEqual([{ id: 'a', score: 0.95, metadata: { dept: 'legal' } }]);
    await expect(m.searchFiltered('kb', { vector: [1, 0], topK: 1, filter: { owner: 'x' } })).rejects.toThrow(/filter fields \(dept\); not on owner/);
  });
});

describe('Oracle explorer', () => {
  const execute = jest.fn(async (sql: string) => {
    if (sql.includes("column_name = 'EMBEDDING'")) return { rows: [{ TABLE_NAME: 'KB_DOCS' }] };
    if (sql.includes('FROM user_tab_columns WHERE table_name')) return { rows: [{ COLUMN_NAME: 'ID', DATA_TYPE: 'VARCHAR2' }, { COLUMN_NAME: 'EMBEDDING', DATA_TYPE: 'VECTOR' }, { COLUMN_NAME: 'DEPT', DATA_TYPE: 'VARCHAR2' }] };
    if (sql.includes('VECTOR_DIMENSION_COUNT')) return { rows: [{ D: 3 }] };
    if (sql.includes('FROM user_tables')) return { rows: [{ NUM_ROWS: 10 }] };
    if (sql.includes('COUNT(*)')) return { rows: [{ N: 12 }] };
    if (sql.includes('FROM user_indexes')) return { rows: [{ INDEX_NAME: 'KB_HNSW', INDEX_SUBTYPE: 'INMEMORY_NEIGHBOR_GRAPH' }] };
    if (sql.includes('VECTOR_DISTANCE')) return { rows: [{ ID: 'a', DEPT: 'legal', DISTANCE: 0.1 }] };
    return { rows: [{ ID: 'a', DEPT: 'legal', EMBEDDING: new Float32Array([1, 2, 3]) }, { ID: 'b', DEPT: 'legal', EMBEDDING: new Float32Array([3, 2, 1]) }] };
  });
  const pool = { getConnection: async () => ({ execute, close: async () => undefined }) };
  const o = set(new OracleVectorAdapter(cfg, gen), 'pool', pool);

  it('lists tables with an EMBEDDING column (lower case) and describes them', async () => {
    expect(await o.listCollections()).toEqual(['kb_docs']);
    expect(await o.describeCollection('kb_docs')).toEqual(expect.objectContaining({ recordCount: 12, dimension: 3, indexes: [expect.objectContaining({ type: 'hnsw' })], fields: [{ name: 'dept', type: 'VARCHAR2' }] }));
  });

  it('pages in id order with bound filters, and searches with them', async () => {
    const page = await o.browse('kb_docs', { limit: 1, cursor: null, filter: { dept: 'legal' } });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE "DEPT" = :f0 ORDER BY id FETCH FIRST :n ROWS ONLY'), expect.objectContaining({ f0: 'legal', n: 2 }));
    expect(page).toEqual({ records: [{ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [1, 2, 3], dimension: 3 }], nextCursor: 'a' });
    expect(await o.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 1, filter: { dept: 'legal' } })).toEqual([{ id: 'a', score: 0.9, metadata: { dept: 'legal' } }]);
    await expect(o.describeCollection('kb docs; drop')).rejects.toThrow(/Invalid table name/);
  });
});
