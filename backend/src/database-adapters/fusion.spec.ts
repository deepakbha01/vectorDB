import { fuseResults } from './vector-explorer';

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
