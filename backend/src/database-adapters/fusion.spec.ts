import { fuseResults, fuseWeighted } from './vector-explorer';
import { bitsToBytes, checkPartition, recordDetail, toBits, toSparse } from './explorer-helpers';

const r = (id: string, score = 1) => ({ id, score, metadata: {} });

describe('hybrid fusion (weighted reciprocal rank fusion)', () => {
  const dense = [r('a'), r('b'), r('c')];
  const keyword = [r('c'), r('d'), r('a')];

  it('rewards records both searches found, and records where each ranked', () => {
    const f = fuseResults(dense, keyword, 0.5, 4);
    expect(f.map((x) => x.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(f.find((x) => x.id === 'a')).toEqual(expect.objectContaining({ denseRank: 1, keywordRank: 3 }));
    expect(f.find((x) => x.id === 'd')).toEqual(expect.objectContaining({ denseRank: null, keywordRank: 2 }));
    expect(f[0].score).toBeCloseTo(0.5 / 61 + 0.5 / 63, 12);
  });

  it('alpha 1 is dense order, alpha 0 is keyword order', () => {
    expect(fuseResults(dense, keyword, 1, 3).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(fuseResults(dense, keyword, 0, 3).map((x) => x.id)).toEqual(['c', 'd', 'a']);
  });

  it('fuses ranks, so wildly different score scales do not matter', () => {
    const f = fuseResults([r('x', 0.99), r('y', 0.98)], [r('y', 42.5), r('x', 3.1)], 0.5, 2);
    expect(f[0].score).toBeCloseTo(f[1].score, 12);
  });
});

describe('weighted score fusion', () => {
  it('rescales each list to 0-1 and weights them', () => {
    // dense 0.9 / 0.5 → 1 / 0; keyword 10 / 2 → 1 / 0.
    const f = fuseWeighted([r('a', 0.9), r('b', 0.5)], [r('b', 10), r('c', 2)], 0.5, 5);
    expect(f.map((x) => [x.id, x.score])).toEqual([['a', 0.5], ['b', 0.5], ['c', 0]]);
    expect(f[1]).toEqual(expect.objectContaining({ denseRank: 2, keywordRank: 1 }));
    // All dense weight: keyword-only hits score 0.
    expect(fuseWeighted([r('a', 0.9)], [r('c', 2)], 1, 5).map((x) => x.id)).toEqual(['a', 'c']);
    expect(fuseWeighted([], [r('c', 2)], 0, 5)).toEqual([expect.objectContaining({ id: 'c', score: 1 })]);
  });
});

describe('sparse and binary vectors', () => {
  it('reads sparse vectors in every database form, 0-based', () => {
    expect(toSparse({ indices: [3, 9], values: [0.5, 0.25] })).toEqual({ indices: [3, 9], values: [0.5, 0.25] });
    expect(toSparse({ '3': 0.5, '9': 0.25 })).toEqual({ indices: [3, 9], values: [0.5, 0.25] });
    expect(toSparse('{1:0.5,4:0.25}/10')).toEqual({ indices: [0, 3], values: [0.5, 0.25] });
    expect(toSparse('{}/10')).toEqual({ indices: [], values: [] });
    expect(toSparse([0.1, 0.2])).toBeNull();
    expect(toSparse('[0.1,0.2]')).toBeNull();
    expect(toSparse({ a: 1 })).toBeNull();
  });

  it('reads bits from pgvector text or bytes, and packs bits back into bytes', () => {
    expect(toBits('1011')).toEqual([1, 0, 1, 1]);
    expect(toBits([0b10100000])).toEqual([1, 0, 1, 0, 0, 0, 0, 0]);
    expect(toBits('10x1')).toBeNull();
    expect(bitsToBytes([1, 0, 1, 0, 0, 0, 0, 0, 1])).toEqual([0b10100000, 0b10000000]);
    expect(toBits(bitsToBytes([1, 1, 0, 0, 1, 0, 1, 1]))).toEqual([1, 1, 0, 0, 1, 0, 1, 1]);
  });

  it('summarises sparse and binary records', () => {
    const s = recordDetail('x', {}, { indices: [5, 1, 9], values: [0.1, -0.8, 0.3] });
    expect(s).toEqual(expect.objectContaining({ kind: 'sparse', dimension: null, vectorHead: null, sparse: { nonZero: 3, top: [{ index: 1, value: -0.8 }, { index: 9, value: 0.3 }, { index: 5, value: 0.1 }] } }));
    expect(s.norm).toBeCloseTo(Math.sqrt(0.74), 6);
    expect(recordDetail('x', {}, '0110', 'binary')).toEqual(expect.objectContaining({ kind: 'binary', dimension: 4, bits: { length: 4, ones: 2, head: '0110' } }));
    expect(recordDetail('x', {}, [0.6, 0.8]).kind).toBeUndefined();
  });
});

describe('partitions', () => {
  const tenants = { kind: 'tenant', names: ['acme', 'globex'], required: true };
  it('checks tenants and namespaces against the collection', () => {
    expect(checkPartition(tenants, 'acme')).toBe('acme');
    expect(() => checkPartition(tenants, undefined)).toThrow(/choose one/);
    expect(() => checkPartition(tenants, 'initech')).toThrow(/no tenant 'initech'/);
    expect(checkPartition({ ...tenants, kind: 'namespace', required: false }, undefined)).toBeUndefined();
    expect(checkPartition({ ...tenants, truncated: true }, 'not-listed')).toBe('not-listed');
    expect(() => checkPartition(undefined, 'acme')).toThrow(/no tenants or namespaces/);
    expect(checkPartition(undefined, undefined)).toBeUndefined();
  });
});
