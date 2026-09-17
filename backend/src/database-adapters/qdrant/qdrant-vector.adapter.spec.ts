import { BadRequestException } from '@nestjs/common';
import { QdrantVectorAdapter } from './qdrant-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mockClientInstance = {
  getCollections: jest.fn(),
  createCollection: jest.fn(),
  createPayloadIndex: jest.fn(),
  updateCollection: jest.fn(),
  upsert: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  deleteCollection: jest.fn(),
};

jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => mockClientInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_QDRANT_URL: 'http://localhost:6333', ...values };
  return { get: (key: string) => defaults[key] };
}

describe('QdrantVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock; generateIndexArtifact: jest.Mock };
  let adapter: QdrantVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({
        qdrant: {
          schema: {
            create_collection_request: { vectors: { size: 768, distance: 'Cosine' } },
            payload_indexes: [{ field_name: 'source_url', field_schema: 'keyword' }],
          },
          notes: [],
        },
      }),
      generateIndexArtifact: jest.fn().mockReturnValue({ statement: JSON.stringify({ hnsw_config: { m: 16, ef_construct: 200 } }), notes: [] }),
    };
    adapter = new QdrantVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy without throwing when no target URL is configured', async () => {
    const unconfigured = new QdrantVectorAdapter(configService({ TARGET_QDRANT_URL: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy when getCollections succeeds', async () => {
    mockClientInstance.getCollections.mockResolvedValue({ collections: [] });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema creates the collection then a payload index per metadata field', async () => {
    mockClientInstance.createCollection.mockResolvedValue(true);
    mockClientInstance.createPayloadIndex.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [{ name: 'source_url', type: 'string' }] });
    expect(mockClientInstance.createCollection).toHaveBeenCalledWith('docs', { vectors: { size: 768, distance: 'Cosine' } });
    expect(mockClientInstance.createPayloadIndex).toHaveBeenCalledWith('docs', { field_name: 'source_url', field_schema: 'keyword' });
  });

  it('createVectorIndex applies the generated hnsw_config via updateCollection', async () => {
    mockClientInstance.updateCollection.mockResolvedValue(true);
    await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
    expect(mockClientInstance.updateCollection).toHaveBeenCalledWith('docs', { hnsw_config: { m: 16, ef_construct: 200 } });
  });

  it('upsert maps records to Qdrant {id, vector, payload} points', async () => {
    mockClientInstance.upsert.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockClientInstance.upsert).toHaveBeenCalledWith('docs', { points: [{ id: '1', vector: [0.1, 0.2], payload: { source_url: 'https://a' } }] });
  });

  it('search maps Qdrant ScoredPoint results, defaulting payload to {}', async () => {
    mockClientInstance.query.mockResolvedValue({ points: [{ id: '1', score: 0.9 }] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.9, metadata: {} }]);
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockClientInstance.deleteCollection).not.toHaveBeenCalled();
  });

  it('dropSchema calls deleteCollection when confirmed', async () => {
    mockClientInstance.deleteCollection.mockResolvedValue(true);
    await adapter.dropSchema('docs', true);
    expect(mockClientInstance.deleteCollection).toHaveBeenCalledWith('docs');
  });
});
