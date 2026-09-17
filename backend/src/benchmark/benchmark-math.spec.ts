import { bruteForceTopK, cosineSimilarity, percentile, recallAtK, syntheticUnitVector } from './benchmark-math';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});

describe('bruteForceTopK', () => {
  it('ranks the closest vectors first', () => {
    const corpus = [
      { id: 'far', vector: [-1, 0] },
      { id: 'near', vector: [0.9, 0.1] },
      { id: 'exact', vector: [1, 0] },
    ];
    expect(bruteForceTopK([1, 0], corpus, 2)).toEqual(['exact', 'near']);
  });
});

describe('recallAtK', () => {
  it('is 1.0 when all ground truth IDs are returned', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'b'])).toBe(1);
  });

  it('is 0.5 when only half of the ground truth is returned', () => {
    expect(recallAtK(['a', 'x'], ['a', 'b'])).toBe(0.5);
  });

  it('is 0 with no overlap', () => {
    expect(recallAtK(['x', 'y'], ['a', 'b'])).toBe(0);
  });
});

describe('percentile', () => {
  it('returns 0 for an empty sample set', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('computes P50 as the median', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  it('computes P95/P99 as high values near the top of the distribution', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 99)).toBe(99);
  });
});

describe('syntheticUnitVector', () => {
  it('produces a unit-length vector of the requested dimension', () => {
    const v = syntheticUnitVector(42, 16);
    expect(v).toHaveLength(16);
    const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('is deterministic for the same seed', () => {
    expect(syntheticUnitVector(7, 8)).toEqual(syntheticUnitVector(7, 8));
  });

  it('differs across seeds', () => {
    expect(syntheticUnitVector(1, 8)).not.toEqual(syntheticUnitVector(2, 8));
  });
});
