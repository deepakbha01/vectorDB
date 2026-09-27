/**
 * Data Explorer against a real LanceDB database: LanceDB is embedded, so a
 * temporary folder is a complete target. The table is created through the
 * adapter itself, explored, and the folder removed. Needs no server.
 * Run with `npm run test:e2e -- data-explorer-lancedb`.
 */
import * as fs from 'fs';
import { parseFilterInput as eqf } from '../src/database-adapters/explorer-helpers';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { LanceDbVectorAdapter } from '../src/database-adapters/lancedb/lancedb-vector.adapter';
import { SimilarityMetric } from '../src/discovery/enums/discovery.enum';
import { project } from '../src/data-explorer/projection';
import * as lancedb from '@lancedb/lancedb';

describe('Data Explorer - LanceDB (embedded, real)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-lancedb-'));
  const adapter = new LanceDbVectorAdapter({ get: (k: string) => (k === 'TARGET_LANCEDB_URI' ? dir : undefined) } as unknown as ConfigService);

  beforeAll(async () => {
    await adapter.createSchema({ collectionOrTableName: 'kb_docs', dimension: 3, metric: SimilarityMetric.COSINE, metadataFields: [{ name: 'dept', type: 'string' }, { name: 'year', type: 'number' }] as any });
    await adapter.upsert('kb_docs', [
      { id: 'a', vector: [1, 0, 0], metadata: { dept: 'legal', year: 2024 } },
      { id: 'b', vector: [0.9, 0.1, 0], metadata: { dept: 'legal', year: 2023 } },
      { id: 'c', vector: [0, 1, 0], metadata: { dept: 'hr', year: 2024 } },
      { id: 'd', vector: [0, 0, 1], metadata: { dept: "o'brien", year: 2022 } },
      { id: 'e', vector: [0.7, 0.7, 0], metadata: { dept: 'legal', year: 2022 } },
    ]);
  }, 60_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists and describes the table: count, dimension from the Arrow schema, fields', async () => {
    expect(await adapter.listCollections()).toEqual(['kb_docs']);
    const info = await adapter.describeCollection('kb_docs');
    expect(info).toEqual(expect.objectContaining({ recordCount: 5, dimension: 3, indexes: [] }));
    expect(info.fields.map((f) => f.name)).toEqual(['dept', 'year']);
  });

  it('pages by offset to the end', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await adapter.browse('kb_docs', { limit: 2, cursor, filter: eqf({}) });
      seen.push(...page.records.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters with escaped literals, and returns whole vectors when asked', async () => {
    const legal2022 = await adapter.browse('kb_docs', { limit: 10, cursor: null, filter: eqf({ dept: 'legal', year: 2022 }) });
    expect(legal2022.records.map((r) => r.id)).toEqual(['e']);
    const quoted = await adapter.browse('kb_docs', { limit: 10, cursor: null, filter: eqf({ dept: "o'brien" }), withVectors: true });
    expect(quoted.records).toEqual([expect.objectContaining({ id: 'd', metadata: { dept: "o'brien", year: 2022 }, dimension: 3, vector: [0, 0, 1] })]);
  });

  it('richer filters on real data: any-of, ranges, in-lists, not-equal', async () => {
    const ids = async (filter: any) => (await adapter.browse('kb_docs', { limit: 10, cursor: null, filter })).records.map((r) => r.id).sort();
    const f = (combine: 'and' | 'or', ...c: Array<[string, any, any]>) => ({ combine, conditions: c.map(([field, op, value]) => ({ field, op, value })) });
    expect(await ids(f('or', ['dept', 'eq', 'hr'], ['year', 'lte', 2022]))).toEqual(['c', 'd', 'e']);
    expect(await ids(f('and', ['year', 'gte', 2023], ['dept', 'ne', 'hr']))).toEqual(['a', 'b']);
    expect(await ids(f('and', ['year', 'in', [2022, 2023]]))).toEqual(['b', 'd', 'e']);
    expect((await adapter.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 5, filter: f('and', ['year', 'lt', 2024]) })).map((r) => r.id)).toEqual(['b', 'e', 'd']);
  });

  it('searches nearest first, with the filter applied', async () => {
    const all = await adapter.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 3, filter: eqf({}) });
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'e']);
    expect(all[0].score).toBeCloseTo(1, 5);
    expect((await adapter.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 3, filter: eqf({ dept: 'hr' }) })).map((r) => r.id)).toEqual(['c']);
  });

  it('keyword search needs a full-text index, then ranks by BM25 with filters', async () => {
    await expect(adapter.keywordSearch('kb_docs', { text: 'legal', topK: 5, filter: eqf({}) })).rejects.toThrow(/no full-text index/);
    const table = await (await lancedb.connect(dir)).openTable('kb_docs');
    await table.createIndex('dept', { config: lancedb.Index.fts() });
    const hits = await adapter.keywordSearch('kb_docs', { text: 'legal', topK: 5, filter: eqf({}) });
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b', 'e']);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect((await adapter.keywordSearch('kb_docs', { text: 'legal', topK: 5, filter: eqf({ year: 2023 }) })).map((h) => h.id)).toEqual(['b']);
  });

  it('fetches one record in full (an id with a quote is escaped), and null for a missing id', async () => {
    expect(await adapter.getRecord('kb_docs', 'd')).toEqual({ id: 'd', metadata: { dept: "o'brien", year: 2022 }, dimension: 3, vectorHead: [0, 0, 1], norm: 1 });
    expect(await adapter.getRecord('kb_docs', "x' OR '1'='1")).toBeNull();
  });

  it('feeds the embedding map: real vectors project to 2D', async () => {
    const page = await adapter.browse('kb_docs', { limit: 10, cursor: null, filter: eqf({}), withVectors: true });
    const p = project(page.records.map((r) => r.vector!), 'pca');
    expect(p.points).toHaveLength(5);
    expect(p.explainedVariance![0]).toBeGreaterThan(0);
  });
});
