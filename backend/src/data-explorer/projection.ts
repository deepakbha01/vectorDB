import { UMAP } from 'umap-js';

/**
 * 2D or 3D projections of a vector sample for the embedding map. Pure and
 * deterministic: the same vectors always give the same picture.
 *
 * - PCA: the directions of greatest variance. Distances along the axes are
 *   meaningful, and it reports how much of the variance the picture keeps.
 * - UMAP: keeps each point's neighbourhood, so clusters show clearly; distances
 *   between clusters and cluster sizes are not meaningful.
 * - t-SNE: keeps local neighbourhoods even more strictly than UMAP and
 *   separates clusters sharply, but global layout means nothing and it is the
 *   slowest (exact, O(n²) per iteration - fine for the map's 1,000 points).
 */

export type ProjectionMethod = 'pca' | 'umap' | 'tsne';
export type ProjectionDims = 2 | 3;

export interface Projection {
  /** One [x, y] or [x, y, z] per vector. */
  points: number[][];
  /** PCA only: share of the total variance each axis keeps (0-1). */
  explainedVariance: number[] | null;
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
 * The top principal components (two or three) by power iteration with
 * deflation, never forming the d×d covariance matrix (d can be several thousand).
 */
export function pca(vectors: number[][], dims: ProjectionDims = 2, iterations = 100): Projection {
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
  // Removes the directions already found, so each component is orthogonal to them.
  const deflate = (w: Float64Array) => {
    for (const prev of components) {
      const k = dot(w, prev);
      for (let j = 0; j < d; j++) w[j] -= k * prev[j];
    }
    return w;
  };
  for (let c = 0; c < dims; c++) {
    let v = normalise(deflate(Float64Array.from({ length: d }, () => rand() - 0.5)));
    for (let it = 0; it < iterations; it++) {
      const w = deflate(covTimes(v));
      // No variance left (fewer points than axes): any orthogonal direction will do.
      if (Math.sqrt(dot(w, w)) <= 1e-12 * (total || 1)) break;
      v = normalise(w);
    }
    v = normalise(deflate(v));
    components.push(v);
    eigen.push(Math.max(0, dot(v, covTimes(v))));
  }
  return {
    points: X.map((row) => components.map((c) => dot(row, c))),
    explainedVariance: total > 0 ? eigen.map((e) => e / total) : null,
  };
}

/** Kept for callers of the 2D-only version. */
export const pca2d = (vectors: number[][], iterations = 100) => pca(vectors, 2, iterations);

export function umap(vectors: number[][], dims: ProjectionDims = 2): Projection {
  const n = vectors.length;
  if (n < 4) return pca(vectors, dims);
  const u = new UMAP({ nComponents: dims, nNeighbors: Math.min(15, n - 1), minDist: 0.1, nEpochs: 200, random: seededRandom(42) });
  return { points: u.fit(vectors), explainedVariance: null };
}

/** Squared Euclidean distances between all pairs, as one n×n array. */
function pairwiseSquared(vectors: number[][]): Float64Array {
  const n = vectors.length;
  const d = vectors[0].length;
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const a = vectors[i];
    for (let j = i + 1; j < n; j++) {
      const b = vectors[j];
      let s = 0;
      for (let k = 0; k < d; k++) {
        const t = a[k] - b[k];
        s += t * t;
      }
      D[i * n + j] = s;
      D[j * n + i] = s;
    }
  }
  return D;
}

/**
 * Input affinities: for each point a Gaussian over the others whose width is
 * found by bisection so that its perplexity matches the target, then
 * symmetrised and normalised.
 */
function affinities(D: Float64Array, n: number, perplexity: number): Float64Array {
  const P = new Float64Array(n * n);
  const target = Math.log(perplexity);
  const row = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let beta = 1;
    let lo = -Infinity;
    let hi = Infinity;
    // Distances are rescaled per row so beta starts in a sensible range.
    let mean = 0;
    for (let j = 0; j < n; j++) if (j !== i) mean += D[i * n + j];
    mean = mean / (n - 1) || 1;
    for (let it = 0; it < 50; it++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        row[j] = j === i ? 0 : Math.exp((-D[i * n + j] / mean) * beta);
        sum += row[j];
      }
      if (sum === 0) sum = 1e-12;
      let H = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const p = row[j] / sum;
        if (p > 1e-12) H -= p * Math.log(p);
      }
      if (Math.abs(H - target) < 1e-4) break;
      if (H > target) {
        lo = beta;
        beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
      } else {
        hi = beta;
        beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2;
      }
    }
    let sum = 0;
    for (let j = 0; j < n; j++) sum += row[j];
    for (let j = 0; j < n; j++) P[i * n + j] = row[j] / (sum || 1);
  }
  // Symmetrise: p_ij = (p_j|i + p_i|j) / 2n.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = Math.max((P[i * n + j] + P[j * n + i]) / (2 * n), 1e-12);
      P[i * n + j] = p;
      P[j * n + i] = p;
    }
    P[i * n + i] = 0;
  }
  return P;
}

/**
 * Exact t-SNE (van der Maaten & Hinton, 2008) with early exaggeration,
 * momentum and per-parameter gains; seeded, so it is deterministic.
 */
export function tsne(vectors: number[][], dims: ProjectionDims = 2, o: { perplexity?: number; iterations?: number } = {}): Projection {
  const n = vectors.length;
  if (n < 5) return pca(vectors, dims);
  const perplexity = Math.max(2, Math.min(o.perplexity ?? 30, (n - 1) / 3));
  const iterations = o.iterations ?? 400;
  const P = affinities(pairwiseSquared(vectors), n, perplexity);
  const rand = seededRandom(7);
  // Small Gaussian start (Box-Muller).
  const Y = new Float64Array(n * dims).map(() => 1e-4 * Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand()));
  const velocity = new Float64Array(n * dims);
  const gains = new Float64Array(n * dims).fill(1);
  // Gradient = 4·Σⱼ (e·pᵢⱼ - qᵢⱼ/Z)·qᵢⱼ·(yᵢ - yⱼ), split into an attractive and a
  // repulsive sum so one pass over the pairs gives both, before Z is known.
  const attract = new Float64Array(n * dims);
  const repel = new Float64Array(n * dims);
  const grad = new Float64Array(n * dims);
  const three = dims === 3;
  const learningRate = Math.max(n / 12, 50);
  for (let it = 0; it < iterations; it++) {
    const exaggeration = it < 100 ? 12 : 1;
    const momentum = it < 250 ? 0.5 : 0.8;
    attract.fill(0);
    repel.fill(0);
    let Z = 0;
    for (let i = 0; i < n; i++) {
      const xi = Y[i * dims];
      const yi = Y[i * dims + 1];
      const zi = three ? Y[i * dims + 2] : 0;
      for (let j = i + 1; j < n; j++) {
        const dx = xi - Y[j * dims];
        const dy = yi - Y[j * dims + 1];
        const dz = three ? zi - Y[j * dims + 2] : 0;
        const q = 1 / (1 + dx * dx + dy * dy + dz * dz);
        Z += 2 * q;
        const a = exaggeration * P[i * n + j] * q;
        const r = q * q;
        attract[i * dims] += a * dx;
        attract[i * dims + 1] += a * dy;
        attract[j * dims] -= a * dx;
        attract[j * dims + 1] -= a * dy;
        repel[i * dims] += r * dx;
        repel[i * dims + 1] += r * dy;
        repel[j * dims] -= r * dx;
        repel[j * dims + 1] -= r * dy;
        if (three) {
          attract[i * dims + 2] += a * dz;
          attract[j * dims + 2] -= a * dz;
          repel[i * dims + 2] += r * dz;
          repel[j * dims + 2] -= r * dz;
        }
      }
    }
    for (let x = 0; x < n * dims; x++) grad[x] = 4 * (attract[x] - repel[x] / Z);
    for (let x = 0; x < n * dims; x++) {
      gains[x] = Math.sign(grad[x]) !== Math.sign(velocity[x]) ? gains[x] + 0.2 : Math.max(gains[x] * 0.8, 0.01);
      velocity[x] = momentum * velocity[x] - learningRate * gains[x] * grad[x];
      Y[x] += velocity[x];
    }
    // Keep the map centred.
    for (let k = 0; k < dims; k++) {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += Y[i * dims + k] / n;
      for (let i = 0; i < n; i++) Y[i * dims + k] -= mean;
    }
  }
  return { points: Array.from({ length: n }, (_, i) => Array.from(Y.subarray(i * dims, (i + 1) * dims))), explainedVariance: null };
}

export function project(vectors: number[][], method: ProjectionMethod, dims: ProjectionDims = 2): Projection {
  if (method === 'umap') return umap(vectors, dims);
  if (method === 'tsne') return tsne(vectors, dims);
  return pca(vectors, dims);
}
