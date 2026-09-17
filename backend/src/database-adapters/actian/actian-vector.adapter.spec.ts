import { BadRequestException } from '@nestjs/common';
import { ActianVectorAdapter } from './actian-vector.adapter';

describe('ActianVectorAdapter', () => {
  let adapter: ActianVectorAdapter;

  beforeEach(() => {
    adapter = new ActianVectorAdapter();
  });

  it('healthCheck reports unhealthy without throwing (documents the missing driver instead)', async () => {
    await expect(adapter.healthCheck()).resolves.toBe(false);
  });

  it('every write/read method throws a clear BadRequestException rather than pretending to connect', async () => {
    await expect(adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.createVectorIndex('docs', 'hnsw' as any, [])).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.upsert('docs', [])).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.search('docs', { vector: [0.1], topK: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.deleteById('docs', ['1'])).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.dropSchema('docs', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the error message points to the ODBC/JDBC workaround, not a generic failure', async () => {
    await expect(adapter.createSchema({ collectionOrTableName: 'docs', dimension: 768, metadataFields: [] })).rejects.toThrow(/ODBC\/JDBC/);
  });
});
