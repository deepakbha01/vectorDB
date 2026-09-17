import { BadRequestException } from '@nestjs/common';
import { OracleVectorAdapter } from './oracle-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mockConnection = { execute: jest.fn(), close: jest.fn() };
const mockPoolInstance = { getConnection: jest.fn().mockResolvedValue(mockConnection), close: jest.fn() };

jest.mock('oracledb', () => ({
  outFormat: 0,
  OUT_FORMAT_OBJECT: 1,
  DB_TYPE_VECTOR: 'DB_TYPE_VECTOR',
  createPool: jest.fn(() => Promise.resolve(mockPoolInstance)),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_ORACLE_CONNECT_STRING: 'localhost/FREEPDB1', ...values };
  return { get: (key: string) => defaults[key] };
}

describe('OracleVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock; generateIndexArtifact: jest.Mock };
  let adapter: OracleVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({ oracle: { ddl: 'CREATE TABLE docs (id VARCHAR2(64));', notes: [] } }),
      generateIndexArtifact: jest.fn().mockReturnValue({ statement: 'CREATE VECTOR INDEX docs_vec_idx ...;', notes: [] }),
    };
    adapter = new OracleVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy without throwing when no connect string is configured', async () => {
    const unconfigured = new OracleVectorAdapter(configService({ TARGET_ORACLE_CONNECT_STRING: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy on a successful SELECT 1 FROM DUAL', async () => {
    mockConnection.execute.mockResolvedValue({});
    await expect(adapter.healthCheck()).resolves.toBe(true);
    expect(mockConnection.execute).toHaveBeenCalledWith('SELECT 1 FROM DUAL');
    expect(mockConnection.close).toHaveBeenCalled();
  });

  it('createSchema splits and executes each statement in the generated DDL', async () => {
    mockConnection.execute.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(mockConnection.execute).toHaveBeenCalledWith('CREATE TABLE docs (id VARCHAR2(64))', [], { autoCommit: true });
  });

  it('upsert coerces boolean metadata to 0/1 and binds the vector as DB_TYPE_VECTOR', async () => {
    mockConnection.execute.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { active: true } }]);
    const [, binds] = mockConnection.execute.mock.calls[0];
    expect(binds.active).toBe(1);
    expect(binds.embedding).toEqual({ val: new Float32Array([0.1, 0.2]), type: 'DB_TYPE_VECTOR' });
  });

  it('search maps VECTOR_DISTANCE to a similarity score and lowercases column names', async () => {
    mockConnection.execute.mockResolvedValue({ rows: [{ ID: '1', DISTANCE: 0.2, SOURCE_URL: 'https://a' }] });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.8, metadata: { source_url: 'https://a' } }]);
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockConnection.execute).not.toHaveBeenCalled();
  });

  it('dropSchema executes DROP TABLE ... PURGE when confirmed', async () => {
    mockConnection.execute.mockResolvedValue({});
    await adapter.dropSchema('docs', true);
    expect(mockConnection.execute).toHaveBeenCalledWith('DROP TABLE docs PURGE', [], { autoCommit: true });
  });

  it('createVectorIndex executes the generated index statement', async () => {
    mockConnection.execute.mockResolvedValue({});
    await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
    expect(schemaGenerator.generateIndexArtifact).toHaveBeenCalledWith('oracle', 'docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
    expect(mockConnection.execute).toHaveBeenCalledWith('CREATE VECTOR INDEX docs_vec_idx ...', [], { autoCommit: true });
  });
});
