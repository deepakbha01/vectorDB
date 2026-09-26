import { BadRequestException } from '@nestjs/common';
import {
  chromaWhere,
  coerceFilter,
  esFilter,
  fieldsFromSample,
  lanceWhere,
  milvusExpr,
  mongoFilter,
  normaliseIndexType,
  normaliseMetric,
  oracleWhere,
  pgWhere,
  pineconeFilter,
  qdrantFilter,
  redisFilter,
  trimValue,
  vectorFields,
  vectorPreview,
} from './explorer-helpers';
import { isExplorable } from './vector-explorer';

describe('Data Explorer helpers', () => {
  it('shortens long text and JSON but leaves small values alone', () => {
    expect(trimValue('short')).toBe('short');
    const long = trimValue('x'.repeat(1500)) as string;
    expect(long.startsWith('x'.repeat(1000))).toBe(true);
    expect(long).toContain('1,500 characters');
    expect(trimValue({ a: 1 })).toEqual({ a: 1 });
    expect(trimValue(12)).toBe(12);
  });

  it('previews a vector from pgvector text, an array or a typed array', () => {
    expect(vectorPreview('[0.1,0.2,0.3]')).toEqual({ vectorPreview: [0.1, 0.2, 0.3], dimension: 3 });
    expect(vectorPreview(Array.from({ length: 20 }, (_, i) => i)).vectorPreview).toHaveLength(8);
    expect(vectorPreview(new Float32Array([1, 2])).dimension).toBe(2);
    expect(vectorPreview(undefined)).toEqual({ vectorPreview: null, dimension: null });
  });

  it("converts filter values to each field's type and refuses unknown fields", () => {
    const fields = [
      { name: 'dept', type: 'text' },
      { name: 'year', type: 'int4' },
      { name: 'public', type: 'bool' },
    ];
    expect(coerceFilter({ dept: 'legal', year: '2024', public: 'TRUE' }, fields)).toEqual({ dept: 'legal', year: 2024, public: true });
    expect(() => coerceFilter({ region: 'eu' }, fields)).toThrow(/no field 'region'/);
    expect(() => coerceFilter({ year: 'recent' }, fields)).toThrow(BadRequestException);
    expect(() => coerceFilter({ public: 'maybe' }, fields)).toThrow(/true or false/);
  });

  it('binds every pgvector filter value and only accepts real columns', () => {
    expect(pgWhere({ dept: 'legal', year: 2024 }, ['dept', 'year'], 3)).toEqual({ sql: '"dept" = $3 AND "year" = $4', params: ['legal', 2024] });
    expect(pgWhere({}, ['dept'], 1)).toEqual({ sql: '', params: [] });
    expect(() => pgWhere({ 'dept"; DROP TABLE x; --': 1 }, ['dept'], 1)).toThrow(/Unknown column/);
  });

  it('builds a Qdrant must-match filter', () => {
    expect(qdrantFilter({ dept: 'legal', year: 2024 })).toEqual({ must: [{ key: 'dept', match: { value: 'legal' } }, { key: 'year', match: { value: 2024 } }] });
    expect(qdrantFilter({})).toBeUndefined();
  });

  it('escapes Milvus string values and refuses odd field names', () => {
    expect(milvusExpr({ dept: 'le"gal\\x', year: 2024, public: true })).toBe('dept == "le\\"gal\\\\x" and year == 2024 and public == true');
    expect(milvusExpr({})).toBe('');
    expect(() => milvusExpr({ 'a or 1==1': 1 })).toThrow(/Invalid field name/);
  });

  it("maps each database's metric and index names onto the platform's", () => {
    expect(['vector_cosine_ops', 'vector_ip_ops', 'vector_l2_ops', 'Cosine', 'Dot', 'Euclid', 'COSINE', 'IP', 'L2'].map(normaliseMetric)).toEqual([
      'cosine', 'dot_product', 'euclidean', 'cosine', 'dot_product', 'euclidean', 'cosine', 'dot_product', 'euclidean',
    ]);
    expect(normaliseMetric(null)).toBeNull();
    expect(['hnsw', 'ivfflat', 'IVF_FLAT', 'IVF_PQ', 'HNSW', 'IVF_SQ8'].map(normaliseIndexType)).toEqual(['hnsw', 'ivf_flat', 'ivf_flat', 'pq', 'hnsw', 'other']);
  });

  it('recognises an adapter that can be explored', () => {
    const base = { platformId: 'milvus', healthCheck: jest.fn() } as any;
    expect(isExplorable(base)).toBe(false);
    expect(isExplorable({ ...base, listCollections: jest.fn(), describeCollection: jest.fn(), browse: jest.fn(), searchFiltered: jest.fn() })).toBe(true);
  });
});

describe('Data Explorer helpers - phase 2 databases', () => {
  it('builds exact-match filters for Pinecone, Chroma and MongoDB', () => {
    expect(pineconeFilter({ dept: 'legal', year: 2024 })).toEqual({ dept: { $eq: 'legal' }, year: { $eq: 2024 } });
    expect(chromaWhere({ dept: 'legal' })).toEqual({ dept: { $eq: 'legal' } });
    expect(chromaWhere({ dept: 'legal', year: 2024 })).toEqual({ $and: [{ dept: { $eq: 'legal' } }, { year: { $eq: 2024 } }] });
    expect(chromaWhere({})).toBeUndefined();
    expect(mongoFilter({ dept: 'legal' })).toEqual({ dept: { $eq: 'legal' } });
    expect(() => mongoFilter({ $where: 'sleep(1000)' })).toThrow(/Invalid field name/);
    expect(() => mongoFilter({ 'a.b': 1 })).toThrow(/Invalid field name/);
  });

  it('uses term for keyword fields and match_phrase for analysed text in Elasticsearch', () => {
    expect(esFilter({ dept: 'legal', body: 'termination clause' }, [{ name: 'dept', type: 'keyword' }, { name: 'body', type: 'text' }])).toEqual([
      { term: { dept: 'legal' } },
      { match_phrase: { body: 'termination clause' } },
    ]);
  });

  it('escapes RediSearch tag, text and numeric values', () => {
    const fields = [{ name: 'dept', type: 'TAG' }, { name: 'year', type: 'NUMERIC' }, { name: 'title', type: 'TEXT' }];
    expect(redisFilter({ dept: 'legal-eu team', year: 2024, title: 'say "hi"' }, fields)).toBe(String.raw`@dept:{legal\-eu\ team} @year:[2024 2024] @title:"say \"hi\""`);
    expect(() => redisFilter({ 'a b': 1 }, fields)).toThrow(/Invalid field name/);
  });

  it('quotes LanceDB columns and doubles quotes in literals', () => {
    expect(lanceWhere({ dept: "o'brien", year: 2024, ok: true })).toBe("`dept` = 'o''brien' AND `year` = 2024 AND `ok` = true");
  });

  it('binds Oracle values against real (upper-case) columns, booleans as 1 / 0', () => {
    expect(oracleWhere({ dept: 'legal', public: true }, ['ID', 'DEPT', 'PUBLIC'])).toEqual({ sql: '"DEPT" = :f0 AND "PUBLIC" = :f1', binds: { f0: 'legal', f1: 1 } });
    expect(() => oracleWhere({ region: 'eu' }, ['DEPT'])).toThrow(/Unknown column/);
  });

  it('infers fields from schemaless records, skipping the id and vector', () => {
    expect(fieldsFromSample([{ _id: 1, dept: 'legal', embedding: [1] }, { year: 2024, ok: true, dept: null }], ['_id', 'embedding'])).toEqual([
      { name: 'dept', type: 'string' },
      { name: 'ok', type: 'boolean' },
      { name: 'year', type: 'number' },
    ]);
  });

  it('returns the whole vector only when asked', () => {
    expect(vectorFields([1, 2, 3])).toEqual({ vectorPreview: [1, 2, 3], dimension: 3 });
    expect(vectorFields(new Float32Array([1, 2]), true)).toEqual({ vectorPreview: [1, 2], dimension: 2, vector: [1, 2] });
  });
});
