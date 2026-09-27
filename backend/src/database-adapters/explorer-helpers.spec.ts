import { BadRequestException } from '@nestjs/common';
import { parseFilterInput as eqf } from './explorer-helpers';
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
    expect(coerceFilter(eqf({ dept: 'legal', year: '2024', public: 'TRUE' }), fields)).toEqual(eqf({ dept: 'legal', year: 2024, public: true }));
    expect(() => coerceFilter(eqf({ region: 'eu' }), fields)).toThrow(/no field 'region'/);
    expect(() => coerceFilter(eqf({ year: 'recent' }), fields)).toThrow(BadRequestException);
    expect(() => coerceFilter(eqf({ public: 'maybe' }), fields)).toThrow(/true or false/);
  });

  it('binds every pgvector filter value and only accepts real columns', () => {
    expect(pgWhere(eqf({ dept: 'legal', year: 2024 }), ['dept', 'year'], 3)).toEqual({ sql: '"dept" = $3 AND "year" = $4', params: ['legal', 2024] });
    expect(pgWhere(eqf({}), ['dept'], 1)).toEqual({ sql: '', params: [] });
    expect(() => pgWhere(eqf({ 'dept"; DROP TABLE x; --': 1 }), ['dept'], 1)).toThrow(/Unknown column/);
  });

  it('builds a Qdrant must-match filter', () => {
    expect(qdrantFilter(eqf({ dept: 'legal', year: 2024 }))).toEqual({ must: [{ key: 'dept', match: { value: 'legal' } }, { key: 'year', match: { value: 2024 } }] });
    expect(qdrantFilter(eqf({}))).toBeUndefined();
  });

  it('escapes Milvus string values and refuses odd field names', () => {
    expect(milvusExpr(eqf({ dept: 'le"gal\\x', year: 2024, public: true }))).toBe('dept == "le\\"gal\\\\x" and year == 2024 and public == true');
    expect(milvusExpr(eqf({}))).toBe('');
    expect(() => milvusExpr(eqf({ 'a or 1==1': 1 }))).toThrow(/Invalid field name/);
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
    expect(pineconeFilter(eqf({ dept: 'legal', year: 2024 }))).toEqual({ $and: [{ dept: { $eq: 'legal' } }, { year: { $eq: 2024 } }] });
    expect(chromaWhere(eqf({ dept: 'legal' }))).toEqual({ dept: { $eq: 'legal' } });
    expect(chromaWhere(eqf({ dept: 'legal', year: 2024 }))).toEqual({ $and: [{ dept: { $eq: 'legal' } }, { year: { $eq: 2024 } }] });
    expect(chromaWhere(eqf({}))).toBeUndefined();
    expect(mongoFilter(eqf({ dept: 'legal' }))).toEqual({ dept: { $eq: 'legal' } });
    expect(() => mongoFilter(eqf({ $where: 'sleep(1000)' }))).toThrow(/Invalid field name/);
    expect(() => mongoFilter(eqf({ 'a.b': 1 }))).toThrow(/Invalid field name/);
  });

  it('uses term for keyword fields and match_phrase for analysed text in Elasticsearch', () => {
    expect(esFilter(eqf({ dept: 'legal', body: 'termination clause' }), [{ name: 'dept', type: 'keyword' }, { name: 'body', type: 'text' }])).toEqual([
      { term: { dept: 'legal' } },
      { match_phrase: { body: 'termination clause' } },
    ]);
  });

  it('escapes RediSearch tag, text and numeric values', () => {
    const fields = [{ name: 'dept', type: 'TAG' }, { name: 'year', type: 'NUMERIC' }, { name: 'title', type: 'TEXT' }];
    expect(redisFilter(eqf({ dept: 'legal-eu team', year: 2024, title: 'say "hi"' }), fields)).toBe(String.raw`@dept:{legal\-eu\ team} @year:[2024 2024] @title:"say \"hi\""`);
    expect(() => redisFilter(eqf({ 'a b': 1 }), fields)).toThrow(/Invalid field name/);
  });

  it('quotes LanceDB columns and doubles quotes in literals', () => {
    expect(lanceWhere(eqf({ dept: "o'brien", year: 2024, ok: true }))).toBe("`dept` = 'o''brien' AND `year` = 2024 AND `ok` = true");
  });

  it('binds Oracle values against real (upper-case) columns, booleans as 1 / 0', () => {
    expect(oracleWhere(eqf({ dept: 'legal', public: true }), ['ID', 'DEPT', 'PUBLIC'])).toEqual({ sql: '"DEPT" = :f0 AND "PUBLIC" = :f1', binds: { f0: 'legal', f1: 1 } });
    expect(() => oracleWhere(eqf({ region: 'eu' }), ['DEPT'])).toThrow(/Unknown column/);
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

describe('richer filters (phase 3): operators, "in", and any-of', () => {
  const f = (combine: 'and' | 'or', ...conditions: Array<[string, any, any]>) => ({ combine, conditions: conditions.map(([field, op, value]) => ({ field, op, value })) });
  const fields = [
    { name: 'dept', type: 'text' },
    { name: 'year', type: 'int4' },
    { name: 'public', type: 'bool' },
  ];

  it('parses both forms and refuses unknown operators', () => {
    expect(eqf({ dept: 'legal' })).toEqual({ combine: 'and', conditions: [{ field: 'dept', op: 'eq', value: 'legal' }] });
    expect(eqf(f('or', ['year', 'gte', 2020]))).toEqual(f('or', ['year', 'gte', 2020]));
    expect(() => eqf({ combine: 'xor', conditions: [] })).toThrow(/'and' or 'or'/);
    expect(() => eqf({ conditions: [{ field: 'a', op: 'like', value: 'x' }] })).toThrow(/Unknown filter operator/);
  });

  it('coerces "in" lists, and keeps range comparisons to numeric fields', () => {
    expect(coerceFilter(f('and', ['year', 'in', '2023, 2024']), fields).conditions[0]).toEqual({ field: 'year', op: 'in', value: [2023, 2024] });
    expect(() => coerceFilter(f('and', ['dept', 'gt', 'a']), fields)).toThrow(/not numeric/);
    expect(() => coerceFilter(f('and', ['public', 'in', 'true']), fields)).toThrow(/boolean/);
    expect(() => coerceFilter(f('and', ['dept', 'eq', ['a', 'b']]), fields)).toThrow(/Only "in"/);
  });

  const any = f('or', ['dept', 'eq', 'legal'], ['year', 'gte', 2024]);
  const mixed = f('and', ['dept', 'ne', 'hr'], ['year', 'in', [2023, 2024]]);

  it('SQL: pgvector binds, Oracle binds each list item, LanceDB escapes', () => {
    expect(pgWhere(any, ['dept', 'year'], 1)).toEqual({ sql: '("dept" = $1 OR "year" >= $2)', params: ['legal', 2024] });
    expect(pgWhere(mixed, ['dept', 'year'], 1)).toEqual({ sql: '"dept" <> $1 AND "year" = ANY($2)', params: ['hr', [2023, 2024]] });
    expect(oracleWhere(mixed, ['DEPT', 'YEAR'])).toEqual({ sql: '"DEPT" <> :f0 AND "YEAR" IN (:f1_0, :f1_1)', binds: { f0: 'hr', f1_0: 2023, f1_1: 2024 } });
    expect(lanceWhere(any)).toBe("(`dept` = 'legal' OR `year` >= 2024)");
  });

  it('Milvus and Qdrant', () => {
    expect(milvusExpr(mixed)).toBe('dept != "hr" and year in [2023, 2024]');
    expect(milvusExpr(any)).toBe('(dept == "legal" or year >= 2024)');
    expect(qdrantFilter(mixed)).toEqual({ must: [{ must_not: [{ key: 'dept', match: { value: 'hr' } }] }, { key: 'year', match: { any: [2023, 2024] } }] });
    expect(qdrantFilter(any)).toEqual({ should: [{ key: 'dept', match: { value: 'legal' } }, { key: 'year', range: { gte: 2024 } }] });
  });

  it('Pinecone / Chroma / MongoDB operators', () => {
    expect(mongoFilter(any)).toEqual({ $or: [{ dept: { $eq: 'legal' } }, { year: { $gte: 2024 } }] });
    expect(pineconeFilter(mixed)).toEqual({ $and: [{ dept: { $ne: 'hr' } }, { year: { $in: [2023, 2024] } }] });
  });

  it('Elasticsearch: must_not, terms, range, and one should for any-of', () => {
    expect(esFilter(mixed, fields)).toEqual([{ bool: { must_not: [{ match_phrase: { dept: 'hr' } }] } }, { terms: { year: [2023, 2024] } }]);
    expect(esFilter(any, fields)).toEqual([{ bool: { should: [{ match_phrase: { dept: 'legal' } }, { range: { year: { gte: 2024 } } }], minimum_should_match: 1 } }]);
  });

  it('RediSearch: negation, numeric ranges, tag lists and | for any-of', () => {
    const rf = [{ name: 'dept', type: 'TAG' }, { name: 'year', type: 'NUMERIC' }];
    expect(redisFilter(mixed, rf)).toBe('-@dept:{hr} (@year:[2023 2023]|@year:[2024 2024])');
    expect(redisFilter(f('and', ['year', 'gt', 2020], ['year', 'lte', 2024]), rf)).toBe('@year:[(2020 +inf] @year:[-inf 2024]');
    expect(redisFilter(any, rf)).toBe('((@dept:{legal})|(@year:[2024 +inf]))');
    expect(redisFilter(f('and', ['dept', 'in', ['a', 'b']]), rf)).toBe('@dept:{a|b}');
  });
});
