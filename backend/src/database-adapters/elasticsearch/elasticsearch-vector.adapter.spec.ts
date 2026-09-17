import { BadRequestException } from '@nestjs/common';
import { ElasticsearchVectorAdapter } from './elasticsearch-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mockClientInstance = {
  cluster: { health: jest.fn() },
  indices: { create: jest.fn(), close: jest.fn(), putMapping: jest.fn(), open: jest.fn(), delete: jest.fn() },
  bulk: jest.fn(),
  search: jest.fn(),
};

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => mockClientInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_ELASTICSEARCH_NODE: 'http://localhost:9200', ...values };
  return { get: (key: string) => defaults[key] };
}

describe('ElasticsearchVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock; generateIndexArtifact: jest.Mock };
  let adapter: ElasticsearchVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({
        elasticsearch: { schema: { index: 'docs', mappings: { properties: { embedding: { type: 'dense_vector', dims: 768 } } } }, notes: [] },
      }),
      generateIndexArtifact: jest.fn().mockReturnValue({ statement: JSON.stringify({ index_options: { type: 'hnsw', m: 16 } }), notes: [] }),
    };
    adapter = new ElasticsearchVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy without throwing when no target node is configured', async () => {
    const unconfigured = new ElasticsearchVectorAdapter(configService({ TARGET_ELASTICSEARCH_NODE: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports unhealthy when cluster status is red, healthy otherwise', async () => {
    mockClientInstance.cluster.health.mockResolvedValue({ status: 'red' });
    await expect(adapter.healthCheck()).resolves.toBe(false);
    mockClientInstance.cluster.health.mockResolvedValue({ status: 'yellow' });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema creates the index with the generated mappings', async () => {
    mockClientInstance.indices.create.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockClientInstance.indices.create).toHaveBeenCalledWith({ index: 'docs', mappings: { properties: { embedding: { type: 'dense_vector', dims: 768 } } } });
  });

  it('createVectorIndex closes, applies index_options via putMapping, then reopens the index', async () => {
    mockClientInstance.indices.close.mockResolvedValue({});
    mockClientInstance.indices.putMapping.mockResolvedValue({});
    mockClientInstance.indices.open.mockResolvedValue({});
    await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
    expect(mockClientInstance.indices.close).toHaveBeenCalledWith({ index: 'docs' });
    expect(mockClientInstance.indices.putMapping).toHaveBeenCalledWith({ index: 'docs', properties: { embedding: { type: 'dense_vector', index_options: { type: 'hnsw', m: 16 } } } });
    expect(mockClientInstance.indices.open).toHaveBeenCalledWith({ index: 'docs' });
  });

  it('upsert throws when bulk reports per-item errors', async () => {
    mockClientInstance.bulk.mockResolvedValue({ errors: true, items: [{ index: { error: { reason: 'mapper_parsing_exception' } } }] });
    await expect(adapter.upsert('docs', [{ id: '1', vector: [0.1], metadata: {} }])).rejects.toThrow(/mapper_parsing_exception/);
  });

  it('search strips the embedding field out of returned metadata', async () => {
    mockClientInstance.search.mockResolvedValue({ hits: { hits: [{ _id: '1', _score: 0.9, _source: { embedding: [0.1], source_url: 'https://a' } }] } });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.9, metadata: { source_url: 'https://a' } }]);
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockClientInstance.indices.delete).not.toHaveBeenCalled();
  });

  it('dropSchema deletes the index when confirmed', async () => {
    mockClientInstance.indices.delete.mockResolvedValue({});
    await adapter.dropSchema('docs', true);
    expect(mockClientInstance.indices.delete).toHaveBeenCalledWith({ index: 'docs' });
  });
});
