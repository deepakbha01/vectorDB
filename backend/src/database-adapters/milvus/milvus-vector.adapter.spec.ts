import { BadRequestException } from '@nestjs/common';
import { MilvusVectorAdapter } from './milvus-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mockClientInstance = {
  checkHealth: jest.fn(),
  createCollection: jest.fn(),
  createIndex: jest.fn(),
  upsert: jest.fn(),
  search: jest.fn(),
  delete: jest.fn(),
  dropCollection: jest.fn(),
};

jest.mock('@zilliz/milvus2-sdk-node', () => ({
  DataType: { VarChar: 21, FloatVector: 101, Double: 11, Bool: 1, Int64: 5, JSON: 23 },
  MilvusClient: jest.fn().mockImplementation(function MockMilvusClient() {
    return mockClientInstance;
  }),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_MILVUS_ADDRESS: 'localhost:19530', ...values };
  return { get: (key: string) => defaults[key] };
}

describe('MilvusVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock; generateIndexArtifact: jest.Mock };
  let adapter: MilvusVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({
        milvus: {
          schema: {
            collection_name: 'docs',
            fields: [
              { name: 'id', data_type: 'VarChar', is_primary_key: true, max_length: 64 },
              { name: 'embedding', data_type: 'FloatVector', dim: 768 },
            ],
          },
          notes: [],
        },
      }),
      generateIndexArtifact: jest.fn().mockReturnValue({
        statement: JSON.stringify({ field_name: 'embedding', index_type: 'HNSW', metric_type: 'COSINE', params: { M: 16 } }),
        notes: [],
      }),
    };
    adapter = new MilvusVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy without throwing when no target address is configured', async () => {
    const unconfigured = new MilvusVectorAdapter(configService({ TARGET_MILVUS_ADDRESS: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy based on checkHealth().isHealthy', async () => {
    mockClientInstance.checkHealth.mockResolvedValue({ isHealthy: true, reasons: [] });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema maps generated string data types to the SDK DataType enum', async () => {
    mockClientInstance.createCollection.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockClientInstance.createCollection).toHaveBeenCalledWith({
      collection_name: 'docs',
      fields: [
        { name: 'id', data_type: 21, is_primary_key: true, max_length: 64 },
        { name: 'embedding', data_type: 101, dim: 768 },
      ],
    });
  });

  it('createVectorIndex parses the generated config and calls createIndex', async () => {
    mockClientInstance.createIndex.mockResolvedValue({});
    await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
    expect(mockClientInstance.createIndex).toHaveBeenCalledWith({
      collection_name: 'docs',
      field_name: 'embedding',
      index_type: 'HNSW',
      metric_type: 'COSINE',
      params: { M: 16 },
    });
  });

  it('upsert flattens id/embedding/metadata into one Milvus row per record', async () => {
    mockClientInstance.upsert.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockClientInstance.upsert).toHaveBeenCalledWith({
      collection_name: 'docs',
      data: [{ id: '1', embedding: [0.1, 0.2], source_url: 'https://a' }],
    });
  });

  it('search excludes embedding from returned metadata', async () => {
    mockClientInstance.search.mockResolvedValue({ results: [{ id: '1', score: 0.9, embedding: [0.1], source_url: 'https://a' }] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.9, metadata: { source_url: 'https://a' } }]);
  });

  it('maps searchParams.efSearch/nprobe to Milvus ef/nprobe search params', async () => {
    mockClientInstance.search.mockResolvedValue({ results: [] });
    await adapter.search('docs', { vector: [0.1], topK: 5, searchParams: { efSearch: 200 } });
    expect(mockClientInstance.search).toHaveBeenCalledWith(expect.objectContaining({ params: { ef: 200 } }));

    await adapter.search('docs', { vector: [0.1], topK: 5, searchParams: { nprobe: 32 } });
    expect(mockClientInstance.search).toHaveBeenCalledWith(expect.objectContaining({ params: { nprobe: 32 } }));
  });

  it('omits params entirely when no searchParams is given', async () => {
    mockClientInstance.search.mockResolvedValue({ results: [] });
    await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(mockClientInstance.search).toHaveBeenCalledWith(expect.not.objectContaining({ params: expect.anything() }));
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockClientInstance.dropCollection).not.toHaveBeenCalled();
  });

  it('dropSchema calls dropCollection when confirmed', async () => {
    mockClientInstance.dropCollection.mockResolvedValue({});
    await adapter.dropSchema('docs', true);
    expect(mockClientInstance.dropCollection).toHaveBeenCalledWith({ collection_name: 'docs' });
  });
});
