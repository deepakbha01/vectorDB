import { BadRequestException } from '@nestjs/common';
import { LanceDbVectorAdapter } from './lancedb-vector.adapter';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mergeInsertBuilder = {
  whenMatchedUpdateAll: jest.fn().mockReturnThis(),
  whenNotMatchedInsertAll: jest.fn().mockReturnThis(),
  execute: jest.fn(),
};

const vectorQuery = {
  distanceType: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  nprobes: jest.fn().mockReturnThis(),
  toArray: jest.fn(),
};

const mockTableInstance = {
  createIndex: jest.fn(),
  mergeInsert: jest.fn(() => mergeInsertBuilder),
  search: jest.fn(() => vectorQuery),
  delete: jest.fn(),
};

const mockConnectionInstance = {
  tableNames: jest.fn(),
  createEmptyTable: jest.fn(),
  openTable: jest.fn(() => Promise.resolve(mockTableInstance)),
  dropTable: jest.fn(),
};

jest.mock('@lancedb/lancedb', () => ({
  connect: jest.fn(() => Promise.resolve(mockConnectionInstance)),
  Index: { hnswSq: jest.fn((opts) => ({ type: 'hnswSq', opts })), ivfPq: jest.fn((opts) => ({ type: 'ivfPq', opts })) },
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_LANCEDB_URI: '/tmp/lancedb', ...values };
  return { get: (key: string) => defaults[key] };
}

describe('LanceDbVectorAdapter', () => {
  let adapter: LanceDbVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LanceDbVectorAdapter(configService() as any);
  });

  it('reports unhealthy without throwing when no target URI is configured', async () => {
    const unconfigured = new LanceDbVectorAdapter(configService({ TARGET_LANCEDB_URI: undefined }) as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy when tableNames() succeeds', async () => {
    mockConnectionInstance.tableNames.mockResolvedValue([]);
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema creates an empty table with an id/embedding/metadata Arrow schema', async () => {
    mockConnectionInstance.createEmptyTable.mockResolvedValue(mockTableInstance);
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [{ name: 'source_url', type: 'string' }] });
    expect(mockConnectionInstance.createEmptyTable).toHaveBeenCalledWith(
      'docs',
      expect.objectContaining({ fields: expect.any(Array) }),
      { mode: 'create', existOk: false },
    );
    const schemaArg = mockConnectionInstance.createEmptyTable.mock.calls[0][1];
    expect(schemaArg.fields.map((f: any) => f.name)).toEqual(['id', 'embedding', 'source_url']);
  });

  it('createVectorIndex maps PQ to Index.ivfPq with numPartitions/numSubVectors from nlist/m', async () => {
    mockTableInstance.createIndex.mockResolvedValue(undefined);
    await adapter.createVectorIndex('docs', IndexType.PQ, [{ name: 'nlist', value: 1024 }, { name: 'm', value: 8 }]);
    expect(mockTableInstance.createIndex).toHaveBeenCalledWith('embedding', { config: { type: 'ivfPq', opts: { numPartitions: 1024, numSubVectors: 8 } } });
  });

  it('createVectorIndex maps HNSW to Index.hnswSq with m/efConstruction', async () => {
    mockTableInstance.createIndex.mockResolvedValue(undefined);
    await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }, { name: 'efConstruction', value: 200 }]);
    expect(mockTableInstance.createIndex).toHaveBeenCalledWith('embedding', { config: { type: 'hnswSq', opts: { m: 16, efConstruction: 200 } } });
  });

  it('upsert uses mergeInsert(on: "id") with match/no-match handlers so re-upserting updates rather than duplicates', async () => {
    mergeInsertBuilder.execute.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockTableInstance.mergeInsert).toHaveBeenCalledWith('id');
    expect(mergeInsertBuilder.execute).toHaveBeenCalledWith([{ id: '1', embedding: [0.1, 0.2], source_url: 'https://a' }]);
  });

  it('search converts cosine distance to a similarity score and strips id/embedding from metadata', async () => {
    vectorQuery.toArray.mockResolvedValue([{ id: '1', embedding: [0.1], _distance: 0.2, source_url: 'https://a' }]);
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.8, metadata: { source_url: 'https://a' } }]);
  });

  it('deleteById builds a quoted SQL IN-predicate, escaping single quotes', async () => {
    mockTableInstance.delete.mockResolvedValue(undefined);
    await adapter.deleteById('docs', ["a'b", 'c']);
    expect(mockTableInstance.delete).toHaveBeenCalledWith("id IN ('a''b', 'c')");
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockConnectionInstance.dropTable).not.toHaveBeenCalled();
  });

  it('dropSchema drops the table when confirmed', async () => {
    mockConnectionInstance.dropTable.mockResolvedValue(undefined);
    await adapter.dropSchema('docs', true);
    expect(mockConnectionInstance.dropTable).toHaveBeenCalledWith('docs');
  });
});
