/**
 * Data Explorer against a real PostgreSQL target (TARGET_PG_* in .env): a
 * throwaway table is created through the adapter itself, explored, then
 * dropped. Works with or without pgvector on the target (the adapter falls
 * back to an array column). Skipped when no target is configured.
 * Run with `npm run test:e2e -- data-explorer`.
 */
import * as path from 'path';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { PostgresVectorAdapter } from '../src/database-adapters/postgres/postgres-vector.adapter';
import { SchemaGeneratorService } from '../src/schema-generator/schema-generator.service';
import { IndexType } from '../src/index-recommendation-engine/enums/index-type.enum';
import { SimilarityMetric } from '../src/discovery/enums/discovery.enum';
import { compareDesign } from '../src/data-explorer/data-explorer.compare';

config({ path: path.join(__dirname, '../.env') });
const configured = !!process.env.TARGET_PG_HOST;
const d = configured ? describe : describe.skip;
const TABLE = `it_explorer_${process.pid}`;

d('Data Explorer - PostgreSQL target', () => {
  const adapter = new PostgresVectorAdapter({ get: (k: string, dflt?: unknown) => process.env[k] ?? dflt } as unknown as ConfigService, new SchemaGeneratorService());
  let pgvector = false;

  beforeAll(async () => {
    await adapter.createSchema({ collectionOrTableName: TABLE, dimension: 3, metric: SimilarityMetric.COSINE, metadataFields: [{ name: 'dept', type: 'string' }, { name: 'year', type: 'number' }] as any });
    pgvector = await (adapter as any).hasPgvector();
    const rows = [
      { id: 'a', vector: [1, 0, 0], metadata: { dept: 'legal', year: 2024 } },
      { id: 'b', vector: [0.9, 0.1, 0], metadata: { dept: 'legal', year: 2023 } },
      { id: 'c', vector: [0, 1, 0], metadata: { dept: 'hr', year: 2024 } },
      { id: 'd', vector: [0, 0, 1], metadata: { dept: 'finance', year: 2022 } },
      { id: 'e', vector: [0.7, 0.7, 0], metadata: { dept: 'legal', year: 2022 } },
    ];
    await adapter.upsert(TABLE, rows);
    if (pgvector) await adapter.createVectorIndex(TABLE, IndexType.HNSW, [{ name: 'M', value: 8 }, { name: 'efConstruction', value: 32 }], SimilarityMetric.COSINE);
  }, 60_000);

  afterAll(async () => {
    await adapter.dropSchema(TABLE, true);
    await adapter.onModuleDestroy();
  });

  it('lists the table as a collection', async () => {
    expect(await adapter.listCollections()).toContain(TABLE);
  });

  it('describes it: count, dimension, fields and - with pgvector - the HNSW index and its metric', async () => {
    const info = await adapter.describeCollection(TABLE);
    expect(info).toEqual(expect.objectContaining({ name: TABLE, recordCount: 5, countIsEstimate: false, dimension: 3 }));
    expect(info.fields.map((f) => f.name)).toEqual(['dept', 'year']);
    if (pgvector) {
      expect(info.indexes).toEqual([expect.objectContaining({ type: 'hnsw' })]);
      expect(info.metric).toBe('cosine');
    } else {
      expect(info.notes.join(' ')).toMatch(/No pgvector/);
    }
    // And the design comparison reads it correctly.
    const checks = compareDesign(TABLE, info, { pipeline: { version: 1, collectionName: TABLE, dimension: 3, metric: 'cosine', metadataFields: ['dept', 'year'] }, index: { version: 1, type: 'hnsw' }, discovery: { version: 1, estimatedVectorCount: 10 } });
    expect(checks.find((c) => c.key === 'dimension')?.status).toBe('match');
    expect(checks.find((c) => c.key === 'fields')?.status).toBe('match');
    expect(checks.find((c) => c.key === 'volume')?.note).toBe('50% of the expected volume.');
  });

  it('pages in id order with a cursor, and filters on typed columns', async () => {
    const first = await adapter.browse(TABLE, { limit: 2, cursor: null, filter: {} });
    expect(first.records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(first.records[0]).toEqual(expect.objectContaining({ metadata: { dept: 'legal', year: 2024 }, vectorPreview: [1, 0, 0], dimension: 3 }));
    const second = await adapter.browse(TABLE, { limit: 2, cursor: first.nextCursor, filter: {} });
    expect(second.records.map((r) => r.id)).toEqual(['c', 'd']);
    const last = await adapter.browse(TABLE, { limit: 2, cursor: second.nextCursor, filter: {} });
    expect([last.records.map((r) => r.id), last.nextCursor]).toEqual([['e'], null]);
    const legal2022 = await adapter.browse(TABLE, { limit: 10, cursor: null, filter: { dept: 'legal', year: 2022 } });
    expect(legal2022.records.map((r) => r.id)).toEqual(['e']);
  });

  it('searches nearest first, with the filter applied', async () => {
    const all = await adapter.searchFiltered(TABLE, { vector: [1, 0, 0], topK: 3, filter: {} });
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'e']);
    expect(all[0].score).toBeCloseTo(1, 5);
    const hr = await adapter.searchFiltered(TABLE, { vector: [1, 0, 0], topK: 3, filter: { dept: 'hr' } });
    expect(hr.map((r) => r.id)).toEqual(['c']);
  });

  it('refuses a filter on a column the table does not have', async () => {
    await expect(adapter.browse(TABLE, { limit: 5, cursor: null, filter: { 'dept"; DROP TABLE x; --': 'x' } })).rejects.toThrow(/Unknown column/);
  });
});
