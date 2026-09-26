/**
 * Data Explorer against a real LanceDB database: LanceDB is embedded, so a
 * temporary folder is a complete target. The table is created through the
 * adapter itself, explored, and the folder removed. Needs no server.
 * Run with `npm run test:e2e -- data-explorer-lancedb`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { LanceDbVectorAdapter } from '../src/database-adapters/lancedb/lancedb-vector.adapter';
import { SimilarityMetric } from '../src/discovery/enums/discovery.enum';
import { project } from '../src/data-explorer/projection';

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
      const page = await adapter.browse('kb_docs', { limit: 2, cursor, filter: {} });
      seen.push(...page.records.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters with escaped literals, and returns whole vectors when asked', async () => {
    const legal2022 = await adapter.browse('kb_docs', { limit: 10, cursor: null, filter: { dept: 'legal', year: 2022 } });
    expect(legal2022.records.map((r) => r.id)).toEqual(['e']);
    const quoted = await adapter.browse('kb_docs', { limit: 10, cursor: null, filter: { dept: "o'brien" }, withVectors: true });
    expect(quoted.records).toEqual([expect.objectContaining({ id: 'd', metadata: { dept: "o'brien", year: 2022 }, dimension: 3, vector: [0, 0, 1] })]);
  });

  it('searches nearest first, with the filter applied', async () => {
    const all = await adapter.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 3, filter: {} });
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'e']);
    expect(all[0].score).toBeCloseTo(1, 5);
    expect((await adapter.searchFiltered('kb_docs', { vector: [1, 0, 0], topK: 3, filter: { dept: 'hr' } })).map((r) => r.id)).toEqual(['c']);
  });

  it('feeds the embedding map: real vectors project to 2D', async () => {
    const page = await adapter.browse('kb_docs', { limit: 10, cursor: null, filter: {}, withVectors: true });
    const p = project(page.records.map((r) => r.vector!), 'pca');
    expect(p.points).toHaveLength(5);
    expect(p.explainedVariance![0]).toBeGreaterThan(0);
  });
});
