/**
 * Data Explorer against a real PostgreSQL target (TARGET_PG_* in .env): a
 * throwaway table is created through the adapter itself, explored, then
 * dropped. Works with or without pgvector on the target (the adapter falls
 * back to an array column). Skipped when no target is configured.
 * Run with `npm run test:e2e -- data-explorer`.
 */
import * as path from 'path';
import { parseFilterInput as eqf } from '../src/database-adapters/explorer-helpers';
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
    const first = await adapter.browse(TABLE, { limit: 2, cursor: null, filter: eqf({}) });
    expect(first.records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(first.records[0]).toEqual(expect.objectContaining({ metadata: { dept: 'legal', year: 2024 }, vectorPreview: [1, 0, 0], dimension: 3 }));
    const second = await adapter.browse(TABLE, { limit: 2, cursor: first.nextCursor, filter: eqf({}) });
    expect(second.records.map((r) => r.id)).toEqual(['c', 'd']);
    const last = await adapter.browse(TABLE, { limit: 2, cursor: second.nextCursor, filter: eqf({}) });
    expect([last.records.map((r) => r.id), last.nextCursor]).toEqual([['e'], null]);
    const legal2022 = await adapter.browse(TABLE, { limit: 10, cursor: null, filter: eqf({ dept: 'legal', year: 2022 }) });
    expect(legal2022.records.map((r) => r.id)).toEqual(['e']);
  });

  it('searches nearest first, with the filter applied', async () => {
    const all = await adapter.searchFiltered(TABLE, { vector: [1, 0, 0], topK: 3, filter: eqf({}) });
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'e']);
    expect(all[0].score).toBeCloseTo(1, 5);
    const hr = await adapter.searchFiltered(TABLE, { vector: [1, 0, 0], topK: 3, filter: eqf({ dept: 'hr' }) });
    expect(hr.map((r) => r.id)).toEqual(['c']);
  });

  it('richer filters on real data: any-of, ranges, in-lists, not-equal', async () => {
    const ids = async (filter: any) => (await adapter.browse(TABLE, { limit: 10, cursor: null, filter })).records.map((r) => r.id).sort();
    const f = (combine: 'and' | 'or', ...c: Array<[string, any, any]>) => ({ combine, conditions: c.map(([field, op, value]) => ({ field, op, value })) });
    expect(await ids(f('or', ['dept', 'eq', 'hr'], ['year', 'lte', 2022]))).toEqual(['c', 'd', 'e']);
    expect(await ids(f('and', ['year', 'gte', 2023], ['dept', 'ne', 'hr']))).toEqual(['a', 'b']);
    expect(await ids(f('and', ['year', 'in', [2022, 2023]]))).toEqual(['b', 'd', 'e']);
    expect((await adapter.searchFiltered(TABLE, { vector: [1, 0, 0], topK: 5, filter: f('and', ['year', 'lt', 2024]) })).map((r) => r.id)).toEqual(['b', 'e', 'd']);
  });

  it('sorts a listing by a field, both ways, paging by offset without overlaps', async () => {
    const all = async (direction: 'asc' | 'desc') => {
      const out: string[] = [];
      let cursor: string | null = null;
      do {
        const p = await adapter.browse(TABLE, { limit: 2, cursor, filter: eqf({}), sort: { field: 'year', direction } });
        out.push(...p.records.map((r) => `${r.metadata.year}:${r.id}`));
        cursor = p.nextCursor;
      } while (cursor);
      return out;
    };
    expect(await all('asc')).toEqual(['2022:d', '2022:e', '2023:b', '2024:a', '2024:c']);
    expect(await all('desc')).toEqual(['2024:a', '2024:c', '2023:b', '2022:d', '2022:e']);
    await expect(adapter.browse(TABLE, { limit: 2, cursor: null, filter: eqf({}), sort: { field: 'embedding', direction: 'asc' } })).rejects.toThrow(/Cannot sort by/);
  });

  it('searches by keyword with Postgres full-text ranking (no extension needed), with filters', async () => {
    const hits = await adapter.keywordSearch(TABLE, { text: 'legal', topK: 10, filter: eqf({}) });
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b', 'e']);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect((await adapter.keywordSearch(TABLE, { text: 'legal', topK: 10, filter: eqf({ year: 2024 }) })).map((h) => h.id)).toEqual(['a']);
    expect(await adapter.keywordSearch(TABLE, { text: 'nonexistentword', topK: 10, filter: eqf({}) })).toEqual([]);
  });

  it('fetches one record in full, and null for a missing id', async () => {
    expect(await adapter.getRecord(TABLE, 'c')).toEqual({ id: 'c', metadata: { dept: 'hr', year: 2024 }, dimension: 3, vectorHead: [0, 1, 0], norm: 1 });
    expect(await adapter.getRecord(TABLE, 'nope')).toBeNull();
  });

  it('refuses a filter on a column the table does not have', async () => {
    await expect(adapter.browse(TABLE, { limit: 5, cursor: null, filter: eqf({ 'dept"; DROP TABLE x; --': 'x' }) })).rejects.toThrow(/Unknown column/);
  });
});
