import { BadRequestException } from '@nestjs/common';
import { WeaviateVectorAdapter } from './weaviate-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mockCollectionInstance = {
  data: { insertMany: jest.fn(), deleteById: jest.fn() },
  query: { nearVector: jest.fn() },
};

const mockClientInstance = {
  isReady: jest.fn(),
  collections: { createFromJson: jest.fn(), use: jest.fn(() => mockCollectionInstance), delete: jest.fn() },
};

jest.mock('weaviate-client', () => ({
  __esModule: true,
  default: { connectToCustom: jest.fn(() => Promise.resolve(mockClientInstance)) },
  connectToCustom: jest.fn(() => Promise.resolve(mockClientInstance)),
  ApiKey: jest.fn().mockImplementation((key: string) => ({ apiKey: key })),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_WEAVIATE_HTTP_HOST: 'localhost', ...values };
  return { get: (key: string, fallback?: any) => defaults[key] ?? fallback };
}

describe('WeaviateVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock; generateIndexArtifact: jest.Mock };
  let adapter: WeaviateVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({
        weaviate: { schema: { class: 'Docs', vectorizer: 'none', properties: [] }, notes: [] },
      }),
      generateIndexArtifact: jest.fn().mockReturnValue({ statement: JSON.stringify({ vectorIndexConfig: { maxConnections: 16 } }), notes: [] }),
    };
    adapter = new WeaviateVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy without throwing when no target host is configured', async () => {
    const unconfigured = new WeaviateVectorAdapter(configService({ TARGET_WEAVIATE_HTTP_HOST: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy based on isReady()', async () => {
    mockClientInstance.isReady.mockResolvedValue(true);
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema passes the generated class schema straight to createFromJson', async () => {
    mockClientInstance.collections.createFromJson.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockClientInstance.collections.createFromJson).toHaveBeenCalledWith({ class: 'Docs', vectorizer: 'none', properties: [] });
  });

  it('upsert PascalCases the class name and maps records to {id, properties, vectors}', async () => {
    mockCollectionInstance.data.insertMany.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockClientInstance.collections.use).toHaveBeenCalledWith('Docs');
    expect(mockCollectionInstance.data.insertMany).toHaveBeenCalledWith([{ id: '1', properties: { source_url: 'https://a' }, vectors: [0.1, 0.2] }]);
  });

  it('search converts distance to a similarity score and returns properties as metadata', async () => {
    mockCollectionInstance.query.nearVector.mockResolvedValue({ objects: [{ uuid: '1', metadata: { distance: 0.2 }, properties: { source_url: 'https://a' } }] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.8, metadata: { source_url: 'https://a' } }]);
  });

  it('createVectorIndex logs the intended config rather than throwing (class recreation required)', async () => {
    await expect(adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }])).resolves.toBeUndefined();
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockClientInstance.collections.delete).not.toHaveBeenCalled();
  });

  it('dropSchema deletes the PascalCased class when confirmed', async () => {
    mockClientInstance.collections.delete.mockResolvedValue(undefined);
    await adapter.dropSchema('docs', true);
    expect(mockClientInstance.collections.delete).toHaveBeenCalledWith('Docs');
  });
});
