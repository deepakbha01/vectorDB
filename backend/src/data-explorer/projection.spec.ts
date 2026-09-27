import { pca, pca2d, project, seededRandom, tsne, umap } from './projection';

/** Two well-separated clusters in 32 dimensions. */
function clusters(perCluster = 40): number[][] {
  const r = seededRandom(3);
  const make = (sign: number) => Array.from({ length: 32 }, (_, j) => (j < 16 ? sign : -sign) + (r() - 0.5) * 0.2);
  return [...Array.from({ length: perCluster }, () => make(1)), ...Array.from({ length: perCluster }, () => make(-1))];
}

/** The two cluster centres are further apart than the first cluster is wide. */
function separated(points: number[][], split: number): boolean {
  const dims = points[0].length;
  const centre = (pts: number[][]) => Array.from({ length: dims }, (_, k) => pts.reduce((s, q) => s + q[k], 0) / pts.length);
  const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, k) => x - b[k]));
  const [a, b] = [centre(points.slice(0, split)), centre(points.slice(split))];
  const spread = Math.max(...points.slice(0, split).map((q) => dist(q, a)));
  return dist(a, b) > spread;
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
    expect(umap(v).points).toEqual(umap(v).points);
    expect(tsne(v, 2, { iterations: 100 }).points).toEqual(tsne(v, 2, { iterations: 100 }).points);
  });

  it('UMAP keeps each cluster together', () => {
    expect(separated(umap(clusters(20)).points, 20)).toBe(true);
  });

  it('t-SNE keeps each cluster together, in 2D and 3D', () => {
    const p2 = tsne(clusters(20), 2, { iterations: 300 }).points;
    expect(p2[0]).toHaveLength(2);
    expect(separated(p2, 20)).toBe(true);
    const p3 = tsne(clusters(20), 3, { iterations: 300 }).points;
    expect(p3[0]).toHaveLength(3);
    expect(separated(p3, 20)).toBe(true);
  });

  it('gives three coordinates in 3D, and PCA a variance share per axis in decreasing order', () => {
    const p = pca(clusters(), 3);
    expect(p.points.every((q) => q.length === 3)).toBe(true);
    const [a, b, c] = p.explainedVariance!;
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(c - 1e-9);
    expect(a + b + c).toBeLessThanOrEqual(1 + 1e-9);
    expect(project(clusters(10), 'umap', 3).points[0]).toHaveLength(3);
  });

  it('handles tiny and empty samples', () => {
    expect(pca2d([]).points).toEqual([]);
    expect(project([[1, 0], [0, 1], [1, 1]], 'umap').points).toHaveLength(3);
    expect(project([[1, 0], [0, 1], [1, 1]], 'tsne', 3).points).toHaveLength(3);
  });
});

describe('PCA with fewer points than axes', () => {
  it('reports no variance on an axis that has none, so the shares never pass 100%', () => {
    const p = pca([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], 3);
    const [a, b, c] = p.explainedVariance!;
    expect(a + b).toBeCloseTo(1, 6);
    expect(c).toBeCloseTo(0, 6);
    expect(p.points.every((q) => q.every(Number.isFinite))).toBe(true);
  });
});
