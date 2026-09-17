import { BadRequestException } from '@nestjs/common';
import { MongoDbAtlasVectorAdapter } from './mongodb-atlas-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';

const mockCollectionInstance = {
  createSearchIndex: jest.fn(),
  bulkWrite: jest.fn(),
  aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
  deleteMany: jest.fn(),
  drop: jest.fn(),
};

const mockDbInstance = {
  command: jest.fn(),
  createCollection: jest.fn(),
  collection: jest.fn(() => mockCollectionInstance),
};

const mockClientInstance = {
  connect: jest.fn(),
  close: jest.fn(),
  db: jest.fn(() => mockDbInstance),
};

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => mockClientInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    TARGET_MONGODB_ATLAS_URI: 'mongodb+srv://user:pass@cluster.mongodb.net',
    TARGET_MONGODB_ATLAS_DATABASE: 'vector_platform',
    ...values,
  };
  return { get: (key: string) => defaults[key] };
}

describe('MongoDbAtlasVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock };
  let adapter: MongoDbAtlasVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({
        mongodb_atlas: {
          schema: { name: 'docs_vector_index', type: 'vectorSearch', definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' }] } },
          notes: [],
        },
      }),
    };
    adapter = new MongoDbAtlasVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy without throwing when no target URI is configured', async () => {
    const unconfigured = new MongoDbAtlasVectorAdapter(configService({ TARGET_MONGODB_ATLAS_URI: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy when the ping command succeeds', async () => {
    mockDbInstance.command.mockResolvedValue({ ok: 1 });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('createSchema creates the collection then submits the generated search index definition', async () => {
    mockDbInstance.createCollection.mockResolvedValue({});
    mockCollectionInstance.createSearchIndex.mockResolvedValue('docs_vector_index');
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockDbInstance.createCollection).toHaveBeenCalledWith('docs');
    expect(mockCollectionInstance.createSearchIndex).toHaveBeenCalledWith({
      name: 'docs_vector_index',
      type: 'vectorSearch',
      definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' }] },
    });
  });

  it('upsert issues one upsert-mode updateOne per record, keyed by _id', async () => {
    mockCollectionInstance.bulkWrite.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a' } }]);
    expect(mockCollectionInstance.bulkWrite).toHaveBeenCalledWith([
      { updateOne: { filter: { _id: '1' }, update: { $set: { _id: '1', embedding: [0.1, 0.2], source_url: 'https://a' } }, upsert: true } },
    ]);
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockCollectionInstance.drop).not.toHaveBeenCalled();
  });

  it('dropSchema drops the collection when confirmed', async () => {
    mockCollectionInstance.drop.mockResolvedValue(true);
    await adapter.dropSchema('docs', true);
    expect(mockCollectionInstance.drop).toHaveBeenCalled();
  });
});
