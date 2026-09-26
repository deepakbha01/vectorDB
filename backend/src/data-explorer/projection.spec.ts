import { pca2d, project, seededRandom, umap2d } from './projection';

/** Two well-separated clusters in 32 dimensions. */
function clusters(perCluster = 40): number[][] {
  const r = seededRandom(3);
  const make = (sign: number) => Array.from({ length: 32 }, (_, j) => (j < 16 ? sign : -sign) + (r() - 0.5) * 0.2);
  return [...Array.from({ length: perCluster }, () => make(1)), ...Array.from({ length: perCluster }, () => make(-1))];
}

describe('embedding map projections', () => {
  it('PCA puts two clusters on opposite sides of the first axis and says how much variance it keeps', () => {
    const p = pca2d(clusters());
    const left = p.points.slice(0, 40).map(([x]) => x);
    const right = p.points.slice(40).map(([x]) => x);
    expect(Math.sign(left[0])).not.toBe(Math.sign(right[0]));
    expect(left.every((x) => Math.sign(x) === Math.sign(left[0]))).toBe(true);
    expect(p.explainedVariance![0]).toBeGreaterThan(0.9);
  });

  it('is deterministic - the same vectors always draw the same map', () => {
    const v = clusters(10);
    expect(pca2d(v).points).toEqual(pca2d(v).points);
    expect(umap2d(v).points).toEqual(umap2d(v).points);
  });

  it('UMAP keeps each cluster together', () => {
    const p = umap2d(clusters(20)).points;
    const centre = (pts: Array<[number, number]>) => [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
    const [a, b] = [centre(p.slice(0, 20)), centre(p.slice(20))];
    const spread = Math.max(...p.slice(0, 20).map((q) => Math.hypot(q[0] - a[0], q[1] - a[1])));
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(spread);
  });

  it('handles tiny and empty samples', () => {
    expect(pca2d([]).points).toEqual([]);
    expect(project([[1, 0], [0, 1], [1, 1]], 'umap').points).toHaveLength(3);
  });
});
