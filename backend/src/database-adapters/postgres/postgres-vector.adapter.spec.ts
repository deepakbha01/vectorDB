import { BadRequestException } from '@nestjs/common';
import { PostgresVectorAdapter } from './postgres-vector.adapter';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPoolInstance = {
  query: jest.fn(),
  connect: jest.fn().mockResolvedValue(mockClient),
  end: jest.fn(),
};

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => mockPoolInstance),
}));

function configService(values: Record<string, any> = {}) {
  const defaults: Record<string, any> = { TARGET_PG_HOST: 'localhost', TARGET_PG_PORT: 5432, ...values };
  return { get: (key: string, fallback?: any) => defaults[key] ?? fallback };
}

describe('PostgresVectorAdapter', () => {
  let schemaGenerator: { generateAll: jest.Mock; generateIndexArtifact: jest.Mock };
  let adapter: PostgresVectorAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    schemaGenerator = {
      generateAll: jest.fn().mockReturnValue({ postgres_pgvector: { ddl: 'CREATE TABLE docs (...);', notes: [] } }),
      generateIndexArtifact: jest.fn().mockReturnValue({ statement: 'CREATE INDEX ...', notes: [] }),
    };
    adapter = new PostgresVectorAdapter(configService() as any, schemaGenerator as unknown as SchemaGeneratorService);
  });

  it('reports unhealthy (without throwing) when no target host is configured', async () => {
    const unconfigured = new PostgresVectorAdapter(configService({ TARGET_PG_HOST: undefined }) as any, schemaGenerator as any);
    await expect(unconfigured.healthCheck()).resolves.toBe(false);
  });

  it('reports healthy on a successful SELECT 1', async () => {
    mockPoolInstance.query.mockResolvedValue({ rows: [] });
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('reports unhealthy without throwing when the query fails', async () => {
    mockPoolInstance.query.mockRejectedValue(new Error('connection refused'));
    await expect(adapter.healthCheck()).resolves.toBe(false);
  });

  it('createSchema executes the DDL generated for postgres', async () => {
    mockPoolInstance.query.mockResolvedValue({});
    await adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] });
    expect(schemaGenerator.generateAll).toHaveBeenCalledWith(expect.objectContaining({ collectionName: 'docs', dimension: 768 }));
    expect(mockPoolInstance.query).toHaveBeenCalledWith('CREATE TABLE docs (...);');
  });

  it('upsert builds an INSERT..ON CONFLICT with dynamic metadata columns inside a transaction', async () => {
    mockClient.query.mockResolvedValue({});
    await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: { source_url: 'https://a', page: 3 } }]);

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    const insertCall = mockClient.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO docs'));
    expect(insertCall[0]).toContain('source_url');
    expect(insertCall[0]).toContain('page');
    expect(insertCall[1]).toEqual(['1', JSON.stringify([0.1, 0.2]), 'https://a', 3]);
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('upsert rolls back the transaction if any insert fails', async () => {
    mockClient.query.mockImplementation((sql: string) => {
      if (String(sql).startsWith('INSERT')) return Promise.reject(new Error('constraint violation'));
      return Promise.resolve({});
    });
    await expect(adapter.upsert('docs', [{ id: '1', vector: [0.1], metadata: {} }])).rejects.toThrow('constraint violation');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('search excludes internal columns from the returned metadata', async () => {
    mockClient.query.mockResolvedValue({
      rows: [{ id: '1', embedding: '[0.1]', score: 0.9, created_at: '2024-01-01', source_url: 'https://a' }],
    });
    const results = await adapter.search('docs', { vector: [0.1], topK: 5 });
    expect(results).toEqual([{ id: '1', score: 0.9, metadata: { source_url: 'https://a' } }]);
    expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN');
  });

  it('search applies efSearch/nprobe as session GUCs inside a transaction when searchParams is given', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    await adapter.search('docs', { vector: [0.1], topK: 5, searchParams: { efSearch: 200, nprobe: 32 } });

    const calls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      'BEGIN',
      'SET LOCAL hnsw.ef_search = 200',
      'SET LOCAL ivfflat.probes = 32',
      expect.stringContaining('SELECT *'),
      'COMMIT',
    ]);
  });

  it('search rolls back if the query fails after applying searchParams', async () => {
    mockClient.query.mockImplementation((sql: string) => {
      if (String(sql).startsWith('SELECT')) return Promise.reject(new Error('syntax error'));
      return Promise.resolve({});
    });
    await expect(adapter.search('docs', { vector: [0.1], topK: 5, searchParams: { efSearch: 200 } })).rejects.toThrow('syntax error');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('dropSchema refuses without explicit confirmation', async () => {
    await expect(adapter.dropSchema('docs', false)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPoolInstance.query).not.toHaveBeenCalled();
  });

  it('dropSchema executes DROP TABLE when confirmed', async () => {
    mockPoolInstance.query.mockResolvedValue({});
    await adapter.dropSchema('docs', true);
    expect(mockPoolInstance.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS docs');
  });

  it('createVectorIndex delegates to the schema generator and executes the result', async () => {
    mockPoolInstance.query.mockResolvedValue({});
    await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
    expect(schemaGenerator.generateIndexArtifact).toHaveBeenCalledWith('postgres_pgvector', 'docs', IndexType.HNSW, [
      { name: 'M', value: 16 },
    ]);
    expect(mockPoolInstance.query).toHaveBeenCalledWith('CREATE INDEX ...');
  });

  describe('when pgvector is not available on the target server', () => {
    beforeEach(() => {
      mockPoolInstance.query.mockImplementation((sql: string) => {
        if (String(sql).includes('CREATE EXTENSION')) return Promise.reject(new Error('extension "vector" is not available'));
        return Promise.resolve({});
      });
    });

    it('createSchema falls back to a plain array-column table instead of failing', async () => {
      await adapter.createSchema({
        collectionOrTableName: 'docs',
        dimension: 768,
        metadataFields: [{ name: 'source_url', type: 'string' } as any],
      });
      expect(schemaGenerator.generateAll).not.toHaveBeenCalled();
      const ddlCall = mockPoolInstance.query.mock.calls.find((c) => String(c[0]).startsWith('CREATE TABLE'));
      expect(ddlCall[0]).toContain('embedding DOUBLE PRECISION[] NOT NULL');
      expect(ddlCall[0]).toContain('source_url TEXT');
    });

    it('createVectorIndex skips index creation instead of failing', async () => {
      await adapter.createVectorIndex('docs', IndexType.HNSW, [{ name: 'M', value: 16 }]);
      expect(schemaGenerator.generateIndexArtifact).not.toHaveBeenCalled();
    });

    it('upsert passes the raw vector array instead of a pgvector text literal', async () => {
      mockClient.query.mockResolvedValue({});
      await adapter.upsert('docs', [{ id: '1', vector: [0.1, 0.2], metadata: {} }]);
      const insertCall = mockClient.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO docs'));
      expect(insertCall[1]).toEqual(['1', [0.1, 0.2]]);
    });

    it('search ranks rows by application-side cosine similarity', async () => {
      mockPoolInstance.query.mockImplementation((sql: string) => {
        if (String(sql).includes('CREATE EXTENSION')) return Promise.reject(new Error('not available'));
        if (String(sql).startsWith('SELECT * FROM')) {
          return Promise.resolve({
            rows: [
              { id: 'far', embedding: [0, 1], source_url: 'https://far' },
              { id: 'close', embedding: [1, 0], source_url: 'https://close' },
            ],
          });
        }
        return Promise.resolve({});
      });
      const results = await adapter.search('docs', { vector: [1, 0], topK: 1 });
      expect(results).toEqual([{ id: 'close', score: 1, metadata: { source_url: 'https://close' } }]);
      expect(mockClient.query).not.toHaveBeenCalled();
    });
  });
});
