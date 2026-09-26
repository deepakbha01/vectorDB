import { UMAP } from 'umap-js';

/**
 * 2D projections of a vector sample for the embedding map. Pure and
 * deterministic: the same vectors always give the same picture.
 *
 * - PCA: the two directions of greatest variance. Distances along the axes
 *   are meaningful, and it reports how much of the variance the picture keeps.
 * - UMAP: keeps each point's neighbourhood, so clusters show clearly; distances
 *   between clusters and cluster sizes are not meaningful.
 */

export type ProjectionMethod = 'pca' | 'umap';

export interface Projection {
  points: Array<[number, number]>;
  /** PCA only: share of the total variance each of the two axes keeps (0-1). */
  explainedVariance: [number, number] | null;
}

/** Mulberry32 - a small seeded generator, so UMAP gives the same layout every time. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const normalise = (v: Float64Array) => {
  const n = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
};

/**
 * The top two principal components by power iteration with deflation, never
 * forming the d×d covariance matrix (d can be several thousand).
 */
export function pca2d(vectors: number[][], iterations = 100): Projection {
  const n = vectors.length;
  const d = vectors[0]?.length ?? 0;
  if (n === 0 || d === 0) return { points: [], explainedVariance: null };
  const mean = new Float64Array(d);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vectors.map((v) => Float64Array.from(v, (x, j) => x - mean[j]));
  const total = X.reduce((s, row) => s + dot(row, row), 0);

  // Covariance times v, as Xᵀ(Xv), in O(n·d).
  const covTimes = (v: Float64Array) => {
    const out = new Float64Array(d);
    for (const row of X) {
      const p = dot(row, v);
      for (let j = 0; j < d; j++) out[j] += row[j] * p;
    }
    return out;
  };
  const components: Float64Array[] = [];
  const eigen: number[] = [];
  const rand = seededRandom(1);
  for (let c = 0; c < 2; c++) {
    let v = normalise(Float64Array.from({ length: d }, () => rand() - 0.5));
    for (let it = 0; it < iterations; it++) {
      const w = covTimes(v);
      for (const prev of components) {
        const k = dot(w, prev);
        for (let j = 0; j < d; j++) w[j] -= k * prev[j];
      }
      v = normalise(w);
    }
    components.push(v);
    eigen.push(dot(v, covTimes(v)));
  }
  return {
    points: X.map((row) => [dot(row, components[0]), dot(row, components[1])] as [number, number]),
    explainedVariance: total > 0 ? [eigen[0] / total, eigen[1] / total] : null,
  };
}

export function umap2d(vectors: number[][]): Projection {
  const n = vectors.length;
  if (n < 4) return pca2d(vectors);
  const umap = new UMAP({ nComponents: 2, nNeighbors: Math.min(15, n - 1), minDist: 0.1, nEpochs: 200, random: seededRandom(42) });
  return { points: umap.fit(vectors) as Array<[number, number]>, explainedVariance: null };
}

export function project(vectors: number[][], method: ProjectionMethod): Projection {
  return method === 'umap' ? umap2d(vectors) : pca2d(vectors);
}
