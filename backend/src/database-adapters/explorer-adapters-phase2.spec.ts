import { ChromaVectorAdapter } from './chroma/chroma-vector.adapter';
import { parseFilterInput as eqf } from './explorer-helpers';
import { PineconeVectorAdapter } from './pinecone/pinecone-vector.adapter';
import { WeaviateVectorAdapter } from './weaviate/weaviate-vector.adapter';
import { ElasticsearchVectorAdapter, PlainJsonTransport } from './elasticsearch/elasticsearch-vector.adapter';
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
    const page = await c.browse('a', { limit: 1, cursor: null, filter: eqf({ dept: 'legal' }) });
    expect(col.get).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2, offset: 0, where: { dept: { $eq: 'legal' } } }));
    expect(page).toEqual({ records: [{ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [0.1, 0.2], dimension: 2 }], nextCursor: '1' });
    expect(await c.searchFiltered('a', { vector: [1, 0], topK: 1, filter: eqf({}) })).toEqual([{ id: 'a', score: 0.75, metadata: { dept: 'legal' } }]);
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
    expect(await p.browse('kb-docs', { limit: 2, cursor: null, filter: eqf({}) })).toEqual(expect.objectContaining({ nextCursor: 'tok2' }));
    await expect(p.browse('kb-docs', { limit: 2, cursor: null, filter: eqf({ dept: 'legal' }) })).rejects.toThrow(/use Search to filter/);
    await p.searchFiltered('kb-docs', { vector: [1, 0], topK: 1, filter: eqf({ dept: 'legal' }) });
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
    await w.browse('KbDocs', { limit: 5, cursor: '10', filter: eqf({ dept: 'legal' }) });
    expect(collection.query.fetchObjects).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 6, offset: 10, filters: { name: 'dept', v: 'legal' } }));
    expect(await w.searchFiltered('KbDocs', { vector: [1, 0, 0], topK: 1, filter: eqf({}) })).toEqual([{ id: 'u1', score: 0.8, metadata: { dept: 'legal' } }]);
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
    const page = await e.browse('docs', { limit: 1, cursor: null, filter: eqf({ dept: 'legal' }) });
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ from: 0, size: 2, query: { bool: { filter: [{ term: { dept: 'legal' } }] } } }));
    expect(page.records[0]).toEqual({ id: 'd1', metadata: { dept: 'legal' }, vectorPreview: [1, 2, 3, 4], dimension: 4 });
    await e.searchFiltered('docs', { vector: [1, 0, 0, 0], topK: 2, filter: eqf({ body: 'notice period' }) });
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ knn: expect.objectContaining({ field: 'embedding', k: 2, filter: { bool: { filter: [{ match_phrase: { body: 'notice period' } }] } } }) }));
    await expect(e.browse('docs', { limit: 100, cursor: '9950', filter: eqf({}) })).rejects.toThrow(/10,000 records deep/);
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
    const page = await r.browse('kb', { limit: 1, cursor: null, filter: eqf({ dept: 'legal' }) });
    expect(search).toHaveBeenLastCalledWith('kb_idx', '@dept:{legal}', expect.objectContaining({ LIMIT: { from: 0, size: 2 } }));
    expect(page.records[0]).toEqual({ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [0.5, -1], dimension: 2 });
  });

  it('pre-filters the KNN query', async () => {
    search.mockResolvedValueOnce({ documents: [{ id: 'kb:a', value: { dept: 'legal', score: '0.1' } }] });
    expect(await r.searchFiltered('kb', { vector: [1, 0], topK: 3, filter: eqf({ dept: 'legal' }) })).toEqual([{ id: 'a', score: 0.9, metadata: { dept: 'legal' } }]);
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
    const page = await m.browse('kb', { limit: 1, cursor: null, filter: eqf({ dept: 'legal' }) });
    expect(find).toHaveBeenLastCalledWith({ dept: { $eq: 'legal' } });
    expect(page.nextCursor).toBe(JSON.stringify({ t: 's', v: 'a' }));
    await m.browse('kb', { limit: 1, cursor: page.nextCursor, filter: eqf({}) });
    expect(find).toHaveBeenLastCalledWith({ _id: { $gt: 'a' } });
    await expect(m.browse('kb', { limit: 1, cursor: 'nonsense', filter: eqf({}) })).rejects.toThrow(/Invalid page cursor/);
  });

  it('filters search only on the index filter fields', async () => {
    expect(await m.searchFiltered('kb', { vector: [1, 0], topK: 1, filter: eqf({ dept: 'legal' }) })).toEqual([{ id: 'a', score: 0.95, metadata: { dept: 'legal' } }]);
    await expect(m.searchFiltered('kb', { vector: [1, 0], topK: 1, filter: eqf({ owner: 'x' }) })).rejects.toThrow(/filter fields \(dept\); not on owner/);
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
    const page = await o.browse('kb_docs', { limit: 1, cursor: null, filter: eqf({ dept: 'legal' }) });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE "DEPT" = :f0 ORDER BY id FETCH FIRST :n ROWS ONLY'), expect.objectContaining({ f0: 'legal', n: 2 }));
    expect(page).toEqual({ records: [{ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [1, 2, 3], dimension: 3 }], nextCursor: 'a' });
    expect(await o.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 1, filter: eqf({ dept: 'legal' }) })).toEqual([{ id: 'a', score: 0.9, metadata: { dept: 'legal' } }]);
    await expect(o.describeCollection('kb docs; drop')).rejects.toThrow(/Invalid table name/);
  });
});

describe('keyword search (phase 3)', () => {
  it('Elasticsearch: BM25 multi_match over the text fields, with filters', async () => {
    const client = {
      indices: { getMapping: jest.fn().mockResolvedValue({ docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 }, dept: { type: 'keyword' }, body: { type: 'text' }, title: { type: 'text' } } } } }) },
      count: jest.fn().mockResolvedValue({ count: 1 }),
      search: jest.fn().mockResolvedValue({ hits: { hits: [{ _id: 'd1', _score: 7.1, _source: { body: 'notice period', embedding: [1, 2] } }] } }),
    };
    const e = set(new ElasticsearchVectorAdapter(cfg, gen), 'client', client);
    expect(await e.keywordSearch('docs', { text: 'notice', topK: 3, filter: eqf({ dept: 'legal' }) })).toEqual([{ id: 'd1', score: 7.1, metadata: { body: 'notice period' } }]);
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ size: 3, query: { bool: { must: [{ multi_match: { query: 'notice', fields: ['body', 'title'] } }], filter: [{ term: { dept: 'legal' } }] } } }));
  });

  it('Weaviate: native BM25 with property filters', async () => {
    const bm25 = jest.fn().mockResolvedValue({ objects: [{ uuid: 'u1', properties: { dept: 'legal' }, metadata: { score: 2.5 } }] });
    const collection = { filter: { byProperty: (n: string) => ({ equal: (v: unknown) => ({ n, v }) }) }, query: { bm25 } };
    const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', { collections: { use: () => collection } });
    expect(await w.keywordSearch('Docs', { text: 'notice', topK: 2, filter: eqf({ dept: 'legal' }) })).toEqual([{ id: 'u1', score: 2.5, metadata: { dept: 'legal' } }]);
    expect(bm25).toHaveBeenCalledWith('notice', expect.objectContaining({ limit: 2, filters: { n: 'dept', v: 'legal' } }));
  });

  it('MongoDB Atlas: needs an Atlas Search index, then $search with a post-filter', async () => {
    const indexes: any[] = [{ name: 'kb_vector_index', type: 'vectorSearch', latestDefinition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 2 }] } }];
    const aggregate = jest.fn(() => ({ toArray: async () => [{ _id: 'a', dept: 'legal', score: 3.3 }] }));
    const collection = { listSearchIndexes: () => ({ toArray: async () => indexes }), aggregate };
    const m = set(new MongoDbAtlasVectorAdapter(cfg, gen), 'db', { collection: () => collection });
    await expect(m.keywordSearch('kb', { text: 'notice', topK: 2, filter: eqf({}) })).rejects.toThrow(/no Atlas Search index/);
    indexes.push({ name: 'kb_text', type: 'search' });
    expect(await m.keywordSearch('kb', { text: 'notice', topK: 2, filter: eqf({ dept: 'legal' }) })).toEqual([{ id: 'a', score: 3.3, metadata: { dept: 'legal' } }]);
    expect(aggregate).toHaveBeenLastCalledWith([
      { $search: { index: 'kb_text', text: { query: 'notice', path: { wildcard: '*' } } } },
      { $match: { dept: { $eq: 'legal' } } },
      { $limit: 2 },
      { $project: { embedding: 0, score: { $meta: 'searchScore' } } },
    ]);
  });
});

describe('sorted listings (phase 3)', () => {
  it('Elasticsearch sorts keyword / numeric fields, not analysed text', async () => {
    const client = {
      indices: { getMapping: jest.fn().mockResolvedValue({ docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 }, year: { type: 'integer' }, body: { type: 'text' } } } } }) },
      count: jest.fn().mockResolvedValue({ count: 1 }),
      search: jest.fn().mockResolvedValue({ hits: { hits: [] } }),
    };
    const e = set(new ElasticsearchVectorAdapter(cfg, gen), 'client', client);
    await e.browse('docs', { limit: 5, cursor: '10', filter: eqf({}), sort: [{ field: 'year', direction: 'desc' }] });
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ from: 10, sort: [{ year: { order: 'desc', missing: '_last' } }] }));
    await expect(e.browse('docs', { limit: 5, cursor: null, filter: eqf({}), sort: [{ field: 'body', direction: 'asc' }] })).rejects.toThrow(/not analysed text/);
  });

  it('MongoDB sorts by the field, then _id, paging by offset', async () => {
    const calls: any = {};
    const cursor = { sort: (s: any) => ((calls.sort = s), cursor), skip: (n: number) => ((calls.skip = n), cursor), limit: () => cursor, toArray: async () => [{ _id: 'a', year: 2024 }] };
    const collection = { listSearchIndexes: () => ({ toArray: async () => [] }), find: () => cursor };
    const m = set(new MongoDbAtlasVectorAdapter(cfg, gen), 'db', { collection: () => collection });
    const page = await m.browse('kb', { limit: 5, cursor: '15', filter: eqf({}), sort: [{ field: 'year', direction: 'desc' }] });
    expect(calls).toEqual({ sort: { year: -1, _id: 1 }, skip: 15 });
    expect(page.nextCursor).toBeNull();
  });

  it('Weaviate passes a property sort', async () => {
    const fetchObjects = jest.fn().mockResolvedValue({ objects: [] });
    const collection = { filter: { byProperty: jest.fn() }, sort: { byProperty: (f: string, asc: boolean) => ({ f, asc }) }, query: { fetchObjects } };
    const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', { collections: { use: () => collection } });
    await w.browse('Docs', { limit: 5, cursor: null, filter: eqf({}), sort: [{ field: 'year', direction: 'asc' }] });
    expect(fetchObjects).toHaveBeenCalledWith(expect.objectContaining({ sort: { f: 'year', asc: true } }));
  });
});

describe('record detail (phase 3)', () => {
  it('Qdrant retrieves numeric ids as numbers and UUIDs as text', async () => {
    const retrieve = jest.fn().mockResolvedValue([{ id: 7, payload: { dept: 'legal' }, vector: [3, 4] }]);
    const q = set(new QdrantVectorAdapter(cfg, gen), 'client', { retrieve, getCollection: jest.fn().mockResolvedValue({ config: { params: { vectors: { size: 2, distance: 'Cosine' } } } }) });
    expect(await q.getRecord('a', '7')).toEqual({ id: '7', metadata: { dept: 'legal' }, dimension: 2, vectorHead: [3, 4], norm: 5 });
    expect(retrieve).toHaveBeenLastCalledWith('a', expect.objectContaining({ ids: [7] }));
    retrieve.mockResolvedValueOnce([]);
    expect(await q.getRecord('a', '5c0e1b34-1d2a-4b1c-9a55-0f5e6f7a8b9c')).toBeNull();
    expect(retrieve).toHaveBeenLastCalledWith('a', expect.objectContaining({ ids: ['5c0e1b34-1d2a-4b1c-9a55-0f5e6f7a8b9c'] }));
  });

  it('Elasticsearch turns a 404 into "not found"', async () => {
    const client = {
      indices: { getMapping: jest.fn().mockResolvedValue({ docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 } } } } }) },
      get: jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { meta: { statusCode: 404 } })),
    };
    expect(await set(new ElasticsearchVectorAdapter(cfg, gen), 'client', client).getRecord('docs', 'x')).toBeNull();
  });

  it('Redis reads the hash and its vector bytes', async () => {
    const vec = Buffer.alloc(8);
    vec.writeFloatLE(0.6, 0);
    vec.writeFloatLE(0.8, 4);
    const client: any = { isOpen: true, hGetAll: jest.fn().mockResolvedValue({ id: 'a', dept: 'legal', embedding: 'garbled' }), withTypeMapping: () => ({ hGet: jest.fn().mockResolvedValue(vec) }) };
    const d = await set(new RedisVectorAdapter(cfg), 'client', client).getRecord('kb', 'a');
    expect(d).toEqual(expect.objectContaining({ id: 'a', metadata: { dept: 'legal' }, dimension: 2 }));
    expect(d!.norm).toBeCloseTo(1, 5);
  });
});

describe('Weaviate named vectors', () => {
  it('lists each named vector and targets the chosen one', async () => {
    const nearVector = jest.fn().mockResolvedValue({ objects: [] });
    const collection = {
      filter: { byProperty: jest.fn() },
      config: { get: jest.fn().mockResolvedValue({ properties: [], vectorizers: { title: { indexType: 'hnsw', indexConfig: { distance: 'cosine' } }, body: { indexType: 'flat', indexConfig: { distance: 'dot' } } } }) },
      aggregate: { overAll: jest.fn().mockResolvedValue({ totalCount: 1 }) },
      query: {
        fetchObjects: jest.fn().mockResolvedValue({ objects: [{ uuid: 'u1', properties: {}, vectors: { title: [1, 0, 0], body: [0.5, 0.5] } }] }),
        nearVector,
      },
    };
    const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', { collections: { use: () => collection } });
    const info = await w.describeCollection('Docs');
    expect(info.vectors).toEqual([{ name: 'title', dimension: 3, metric: 'cosine' }, { name: 'body', dimension: 2, metric: 'dot_product' }]);
    const page = await w.browse('Docs', { limit: 1, cursor: null, filter: eqf({}), withVectors: true, vectorName: 'body' });
    expect(page.records[0].vector).toEqual([0.5, 0.5]);
    await w.searchFiltered('Docs', { vector: [1, 0], topK: 2, filter: eqf({}), vectorName: 'body' });
    expect(nearVector).toHaveBeenCalledWith([1, 0], expect.objectContaining({ targetVector: 'body' }));
  });
});

describe('sorting by several fields (phase 4)', () => {
  it('Elasticsearch, MongoDB and Weaviate apply every field in order', async () => {
    const client = {
      indices: { getMapping: jest.fn().mockResolvedValue({ docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 }, year: { type: 'integer' }, dept: { type: 'keyword' } } } } }) },
      count: jest.fn().mockResolvedValue({ count: 1 }),
      search: jest.fn().mockResolvedValue({ hits: { hits: [] } }),
    };
    const e = set(new ElasticsearchVectorAdapter(cfg, gen), 'client', client);
    await e.browse('docs', { limit: 5, cursor: null, filter: eqf({}), sort: [{ field: 'dept', direction: 'asc' }, { field: 'year', direction: 'desc' }] });
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({ sort: [{ dept: { order: 'asc', missing: '_last' } }, { year: { order: 'desc', missing: '_last' } }] }));

    const calls: any = {};
    const cursor = { sort: (s: any) => ((calls.sort = s), cursor), skip: () => cursor, limit: () => cursor, toArray: async () => [] };
    const m = set(new MongoDbAtlasVectorAdapter(cfg, gen), 'db', { collection: () => ({ listSearchIndexes: () => ({ toArray: async () => [] }), find: () => cursor }) });
    await m.browse('kb', { limit: 5, cursor: null, filter: eqf({}), sort: [{ field: 'dept', direction: 'asc' }, { field: 'year', direction: 'desc' }] });
    expect(Object.entries(calls.sort)).toEqual([['dept', 1], ['year', -1], ['_id', 1]]);

    const chain: Array<[string, boolean]> = [];
    const sorter: any = { byProperty: (f: string, asc: boolean) => (chain.push([f, asc]), sorter) };
    const fetchObjects = jest.fn().mockResolvedValue({ objects: [] });
    const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', { collections: { use: () => ({ filter: { byProperty: jest.fn() }, sort: sorter, query: { fetchObjects } }) } });
    await w.browse('Docs', { limit: 5, cursor: null, filter: eqf({}), sort: [{ field: 'dept', direction: 'asc' }, { field: 'year', direction: 'desc' }] });
    expect(chain).toEqual([['dept', true], ['year', false]]);
  });
});

describe('phase 4 - sparse and binary vectors', () => {
  it('Qdrant lists sparse vectors and searches them as { indices, values } with using', async () => {
    const query = jest.fn().mockResolvedValue({ points: [{ id: 1, score: 3.2, payload: {} }] });
    const retrieve = jest.fn().mockResolvedValue([{ id: 1, payload: {}, vector: { '': [0.6, 0.8], splade: { indices: [4, 2], values: [0.9, 0.1] } } }]);
    const q = set(new QdrantVectorAdapter(cfg, gen), 'client', {
      getCollection: jest.fn().mockResolvedValue({ points_count: 1, config: { params: { vectors: { size: 2, distance: 'Cosine' }, sparse_vectors: { splade: {} } }, hnsw_config: {} }, payload_schema: {} }),
      query,
      retrieve,
    });
    const info = await q.describeCollection('docs');
    expect(info.vectors).toEqual([{ name: '', dimension: 2, metric: 'cosine', kind: 'dense' }, { name: 'splade', dimension: null, metric: 'dot_product', kind: 'sparse' }]);
    expect(q.searchableKinds).toEqual(['sparse']);
    await q.searchFiltered('docs', { vector: [], sparse: { indices: [4], values: [1] }, topK: 3, filter: eqf({}), vectorName: 'splade' });
    expect(query).toHaveBeenLastCalledWith('docs', expect.objectContaining({ query: { indices: [4], values: [1] }, using: 'splade' }));
    const rec = await q.getRecord('docs', '1', { vectorName: 'splade' });
    expect(rec).toEqual(expect.objectContaining({ kind: 'sparse', sparse: { nonZero: 2, top: [{ index: 4, value: 0.9 }, { index: 2, value: 0.1 }] } }));
  });

  it('Milvus lists every vector field and searches sparse as index → weight, binary as bytes, on the chosen field', async () => {
    const search = jest.fn().mockResolvedValue({ results: [{ id: 'a', score: 0.5, dept: 'legal', dense: [1, 0], splade: { 3: 0.2 } }] });
    const client = {
      describeCollection: jest.fn().mockResolvedValue({
        schema: {
          fields: [
            { name: 'id', data_type: 'VarChar', is_primary_key: true },
            { name: 'dense', data_type: 'FloatVector', type_params: [{ key: 'dim', value: '2' }] },
            { name: 'splade', data_type: 'SparseFloatVector' },
            { name: 'codes', data_type: 'BinaryVector', type_params: [{ key: 'dim', value: '16' }] },
            { name: 'dept', data_type: 'VarChar' },
          ],
        },
      }),
      getCollectionStatistics: jest.fn().mockResolvedValue({ stats: [{ key: 'row_count', value: '1' }] }),
      describeIndex: jest.fn().mockResolvedValue({ index_descriptions: [
        { field_name: 'dense', params: [{ key: 'index_type', value: 'HNSW' }, { key: 'metric_type', value: 'COSINE' }] },
        { field_name: 'splade', params: [{ key: 'index_type', value: 'SPARSE_INVERTED_INDEX' }, { key: 'metric_type', value: 'IP' }] },
      ] }),
      getLoadState: jest.fn().mockResolvedValue({ state: 'LoadStateLoaded' }),
      query: jest.fn().mockResolvedValue({ data: [{ id: 'a', dept: 'legal', codes: [0b10000000, 0b00000001] }] }),
      search,
    };
    const m = set(new MilvusVectorAdapter(cfg, gen), 'client', client);
    const info = await m.describeCollection('docs');
    expect(info.fields).toEqual([{ name: 'dept', type: 'VarChar' }]);
    expect(info.vectors).toEqual([
      { name: 'dense', dimension: 2, metric: 'cosine', kind: 'dense' },
      { name: 'splade', dimension: null, metric: 'dot_product', kind: 'sparse' },
      { name: 'codes', dimension: 16, metric: null, kind: 'binary' },
    ]);
    const hits = await m.searchFiltered('docs', { vector: [], sparse: { indices: [3, 9], values: [0.2, 0.4] }, topK: 2, filter: eqf({}), vectorName: 'splade' });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ anns_field: 'splade', data: [{ 3: 0.2, 9: 0.4 }] }));
    // Vector fields never show up as metadata.
    expect(hits[0].metadata).toEqual({ dept: 'legal' });
    await m.searchFiltered('docs', { vector: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], topK: 2, filter: eqf({}), vectorName: 'codes' });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ anns_field: 'codes', data: [[0b10000000, 0b00000001]] }));
    await expect(m.searchFiltered('docs', { vector: [1, 0, 1], topK: 2, filter: eqf({}), vectorName: 'codes' })).rejects.toThrow(/holds 16 bits/);
    await expect(m.searchFiltered('docs', { vector: [1], topK: 2, filter: eqf({}), vectorName: 'splade' })).rejects.toThrow(/search it with a sparse vector/);
    await m.searchFiltered('docs', { vector: [1, 0], topK: 2, filter: eqf({}) });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ anns_field: 'dense', data: [[1, 0]] }));
    const rec = await m.getRecord('docs', 'a', { vectorName: 'codes' });
    expect(rec).toEqual(expect.objectContaining({ kind: 'binary', dimension: 16, bits: { length: 16, ones: 2, head: '1000000000000001' } }));
    await expect(m.getRecord('docs', 'a', { vectorName: 'nope' })).rejects.toThrow(/no vector field 'nope'/);
  });

  it('pgvector treats sparsevec and bit columns as vectors, searched by cosine and Hamming distance', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('information_schema.columns')) return { rows: [{ name: 'id', type: 'text' }, { name: 'embedding', type: 'vector' }, { name: 'splade', type: 'sparsevec' }, { name: 'codes', type: 'bit' }, { name: 'dept', type: 'text' }] };
        if (sql.includes('atttypmod')) return { rows: [{ dim: params?.[1] === 'codes' ? 8 : params?.[1] === 'splade' ? 1000 : 3 }] };
        if (sql.includes('pg_extension')) return { rows: [{ ok: 1 }] };
        return { rows: [{ id: 'a', embedding: '[1,0,0]', splade: '{5:0.5}/1000', codes: '10110000', dept: 'legal', score: 0.75 }] };
      }),
    };
    const p = set(new PostgresVectorAdapter(cfg, gen), 'pool', pool);
    (p as any).hasPgvector = async () => true;
    const sparseHits = await p.searchFiltered('docs', { vector: [], sparse: { indices: [4, 9], values: [0.5, 0.25] }, topK: 3, filter: eqf({}), vectorName: 'splade' });
    const last = queries[queries.length - 1];
    expect(last.sql).toContain('"splade" <=> $1::sparsevec');
    expect(last.params?.[0]).toBe('{5:0.5,10:0.25}/1000');
    expect(sparseHits).toEqual([{ id: 'a', score: 0.75, metadata: { dept: 'legal' } }]);
    await p.searchFiltered('docs', { vector: [1, 0, 1, 1, 0, 0, 0, 0], topK: 3, filter: eqf({}), vectorName: 'codes' });
    expect(queries[queries.length - 1].sql).toContain('"codes" <~> $1::bit(8)');
    expect(queries[queries.length - 1].params?.[0]).toBe('10110000');
    await expect(p.searchFiltered('docs', { vector: [1, 0], topK: 3, filter: eqf({}), vectorName: 'codes' })).rejects.toThrow(/holds 8 bits/);
    await expect(p.searchFiltered('docs', { vector: [], sparse: { indices: [1000], values: [1] }, topK: 3, filter: eqf({}), vectorName: 'splade' })).rejects.toThrow(/0 to 999/);
    const rec = await p.getRecord('docs', 'a', { vectorName: 'splade' });
    expect(rec).toEqual(expect.objectContaining({ kind: 'sparse', metadata: { dept: 'legal', score: 0.75 }, sparse: { nonZero: 1, top: [{ index: 4, value: 0.5 }] } }));
    // Listings keep vector columns out of the metadata.
    const page = await p.browse('docs', { limit: 5, cursor: null, filter: eqf({}) });
    expect(page.records[0].metadata).toEqual({ dept: 'legal', score: 0.75 });
  });
});

describe('phase 4 - tenants, namespaces and native hybrid', () => {
  it('Weaviate lists tenants, reads one tenant at a time, and runs its own hybrid search', async () => {
    const hybrid = jest.fn().mockResolvedValue({ objects: [{ uuid: 'u1', properties: { dept: 'legal' }, metadata: { score: 0.8 } }] });
    const tenantHandle = {
      filter: { byProperty: jest.fn() },
      aggregate: { overAll: jest.fn().mockResolvedValue({ totalCount: 3 }) },
      query: { fetchObjects: jest.fn().mockResolvedValue({ objects: [] }), hybrid },
    };
    const withTenant = jest.fn(() => tenantHandle);
    const base = {
      config: { get: jest.fn().mockResolvedValue({ properties: [], vectorizers: { default: { indexType: 'hnsw', indexConfig: { distance: 'cosine' } } }, multiTenancy: { enabled: true } }) },
      tenants: { get: jest.fn().mockResolvedValue({ globex: { name: 'globex' }, acme: { name: 'acme' } }) },
      withTenant,
    };
    const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', { collections: { use: () => base } });
    const info = await w.describeCollection('Docs', 'globex');
    expect(info.partitions).toEqual({ kind: 'tenant', names: ['acme', 'globex'], required: true });
    expect(info.recordCount).toBe(3);
    expect(withTenant).toHaveBeenLastCalledWith('globex');
    await w.browse('Docs', { limit: 5, cursor: null, filter: eqf({}), partition: 'acme' });
    expect(withTenant).toHaveBeenLastCalledWith('acme');
    const r = await w.nativeHybrid('Docs', { text: 'contract', vector: [1, 0], alpha: 0.25, topK: 4, filter: eqf({}), partition: 'acme', vectorName: 'body' });
    expect(hybrid).toHaveBeenCalledWith('contract', expect.objectContaining({ alpha: 0.25, vector: [1, 0], limit: 4, targetVector: 'body' }));
    expect(r).toEqual([{ id: 'u1', score: 0.8, metadata: { dept: 'legal' } }]);
  });

  it('Pinecone lists namespaces with their counts and reads one', async () => {
    const nsQuery = jest.fn().mockResolvedValue({ matches: [] });
    const nsFetch = jest.fn().mockResolvedValue({ records: {} });
    const namespace = jest.fn(() => ({ query: nsQuery, fetch: nsFetch, listPaginated: jest.fn().mockResolvedValue({ vectors: [] }) }));
    const index = { describeIndexStats: jest.fn().mockResolvedValue({ totalRecordCount: 30, namespaces: { '': { recordCount: 10 }, tenant_b: { recordCount: 5 }, tenant_a: { recordCount: 15 } } }), listPaginated: jest.fn().mockResolvedValue({ vectors: [] }), namespace };
    const p = set(new PineconeVectorAdapter(cfg), 'client', { describeIndex: jest.fn().mockResolvedValue({ dimension: 2, metric: 'cosine', spec: { serverless: {} } }), index: () => index });
    const info = await p.describeCollection('kb');
    expect(info.partitions).toEqual({ kind: 'namespace', names: ['tenant_a', 'tenant_b'], counts: { tenant_b: 5, tenant_a: 15 }, required: false });
    await p.searchFiltered('kb', { vector: [1, 0], topK: 2, filter: eqf({}), partition: 'tenant_a' });
    expect(namespace).toHaveBeenLastCalledWith('tenant_a');
    expect(nsQuery).toHaveBeenCalled();
    await p.getRecord('kb', 'x', { partition: 'tenant_b' });
    expect(namespace).toHaveBeenLastCalledWith('tenant_b');
  });

  it('Elasticsearch runs BM25 and kNN in one RRF retriever', async () => {
    const search = jest.fn().mockResolvedValue({ hits: { hits: [{ _id: 'd1', _score: 0.03, _source: { body: 'x', embedding: [1, 0] } }] } });
    const e = set(new ElasticsearchVectorAdapter(cfg, gen), 'client', {
      indices: { getMapping: jest.fn().mockResolvedValue({ docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 }, body: { type: 'text' }, dept: { type: 'keyword' } } } } }) },
      count: jest.fn().mockResolvedValue({ count: 1 }),
      search,
    });
    const r = await e.nativeHybrid('docs', { text: 'termination', vector: [1, 0], alpha: 0.5, topK: 5, filter: eqf({ dept: 'legal' }) });
    const body = search.mock.calls[0][0];
    expect(body.size).toBe(5);
    expect(body.retriever.rrf.rank_window_size).toBe(50);
    expect(body.retriever.rrf.retrievers[0].standard.query.bool.must[0].multi_match).toEqual({ query: 'termination', fields: ['body'] });
    expect(body.retriever.rrf.retrievers[1].knn).toEqual(expect.objectContaining({ field: 'embedding', query_vector: [1, 0], k: 50 }));
    expect(body.retriever.rrf.retrievers[1].knn.filter).toBeDefined();
    expect(r).toEqual([{ id: 'd1', score: 0.03, metadata: { body: 'x' } }]);
  });
});

describe('named vectors with none chosen (found on a real Qdrant)', () => {
  it('Qdrant names the first named vector in search and record reads; an unnamed vector needs no name', async () => {
    const query = jest.fn().mockResolvedValue({ points: [] });
    const retrieve = jest.fn().mockResolvedValue([{ id: 1, payload: {}, vector: { splade: { indices: [1], values: [1] }, body: [0.6, 0.8], title: [1, 0, 0] } }]);
    const named = set(new QdrantVectorAdapter(cfg, gen), 'client', {
      getCollection: jest.fn().mockResolvedValue({ config: { params: { vectors: { body: { size: 2, distance: 'Dot' }, title: { size: 3, distance: 'Cosine' } }, sparse_vectors: { splade: {} } } } }),
      query,
      retrieve,
    });
    await named.searchFiltered('docs', { vector: [0, 1], topK: 2, filter: eqf({}) });
    expect(query).toHaveBeenLastCalledWith('docs', expect.objectContaining({ using: 'body' }));
    expect((await named.getRecord('docs', '1'))?.vectorHead).toEqual([0.6, 0.8]);
    const unnamed = set(new QdrantVectorAdapter(cfg, gen), 'client', { getCollection: jest.fn().mockResolvedValue({ config: { params: { vectors: { size: 2, distance: 'Cosine' } } } }), query });
    await unnamed.searchFiltered('docs', { vector: [0, 1], topK: 2, filter: eqf({}) });
    expect(query.mock.calls[query.mock.calls.length - 1][1].using).toBeUndefined();
  });

  it('Weaviate targets the first named vector when a collection has several', async () => {
    const nearVector = jest.fn().mockResolvedValue({ objects: [] });
    const fetchObjectById = jest.fn().mockResolvedValue({ uuid: '5c0e1b34-1d2a-4b1c-9a55-0f5e6f7a8b9c', properties: {}, vectors: { body: [0.6, 0.8], title: [1, 0, 0] } });
    const collection = {
      filter: { byProperty: jest.fn() },
      config: { get: jest.fn().mockResolvedValue({ properties: [], vectorizers: { title: { indexType: 'hnsw' }, body: { indexType: 'hnsw' } } }) },
      query: { nearVector, fetchObjectById, hybrid: jest.fn().mockResolvedValue({ objects: [] }) },
    };
    const w = set(new WeaviateVectorAdapter(cfg, gen), 'client', { collections: { use: () => collection } });
    await w.searchFiltered('Docs', { vector: [1, 0, 0], topK: 2, filter: eqf({}) });
    expect(nearVector).toHaveBeenCalledWith([1, 0, 0], expect.objectContaining({ targetVector: 'title' }));
    await w.nativeHybrid('Docs', { text: 'x', vector: [1, 0, 0], alpha: 0.5, topK: 2, filter: eqf({}) });
    expect(collection.query.hybrid).toHaveBeenCalledWith('x', expect.objectContaining({ targetVector: 'title' }));
    expect((await w.getRecord('Docs', '5c0e1b34-1d2a-4b1c-9a55-0f5e6f7a8b9c'))?.vectorHead).toEqual([1, 0, 0]);
    // A collection with one unnamed ("default") vector needs no target.
    collection.config.get.mockResolvedValue({ properties: [], vectorizers: { default: { indexType: 'hnsw' } } });
    await w.searchFiltered('Docs', { vector: [1, 0, 0], topK: 2, filter: eqf({}) });
    expect(nearVector.mock.calls[nearVector.mock.calls.length - 1][1].targetVector).toBeUndefined();
  });
});

describe('Elasticsearch against 8.x clusters (found on a real 8.19 cluster)', () => {
  it('sends plain JSON, which 8.x and 9.x both accept, not the 9.x-only compatibility headers', () => {
    const e = new ElasticsearchVectorAdapter({ get: (k: string) => (k === 'TARGET_ELASTICSEARCH_NODE' ? 'http://127.0.0.1:9200' : undefined) } as any, gen);
    expect((e as any).getClient().transport).toBeInstanceOf(PlainJsonTransport);
  });

  it('explains a licence without RRF instead of passing on the security error', async () => {
    const e = set(new ElasticsearchVectorAdapter(cfg, gen), 'client', {
      indices: { getMapping: jest.fn().mockResolvedValue({ docs: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 }, body: { type: 'text' } } } } }) },
      count: jest.fn().mockResolvedValue({ count: 1 }),
      search: jest.fn().mockRejectedValue(new Error('security_exception: current license is non-compliant for [Reciprocal Rank Fusion (RRF)]')),
    });
    await expect(e.nativeHybrid('docs', { text: 'x', vector: [1, 0], alpha: 0.5, topK: 3, filter: eqf({}) })).rejects.toThrow(/licence does not include RRF.*rank or weighted fusion/);
  });
});
