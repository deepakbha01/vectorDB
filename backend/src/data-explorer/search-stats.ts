/**
 * Search statistics and A/B comparison (Data Explorer) - pure.
 */

export interface ScoreStats {
  count: number;
  max: number | null;
  min: number | null;
  mean: number | null;
  median: number | null;
  /** Top result minus the second: a large gap means one clear best match. */
  topGap: number | null;
  /** Population standard deviation of the scores. */
  stdDev: number | null;
  /**
   * How far the top result stands above the rest, in standard deviations of
   * the scores ((max - mean) / stdDev). Roughly: under 1 the list is flat,
   * above 2 the top result stands out. Null when all scores are equal.
   */
  topZ: number | null;
}

/** The query vector itself - a very small or large norm, or a zero vector, explains odd scores. */
export type QueryStats =
  | { kind: 'dense'; dimension: number; norm: number; mean: number; variance: number; zeros: number; normalised: boolean }
  | { kind: 'sparse'; nonZero: number; norm: number; maxIndex: number | null }
  | { kind: 'binary'; bits: number; ones: number };

export function queryStats(q: { vector?: number[] | null; sparse?: { indices: number[]; values: number[] }; binary?: boolean }): QueryStats | null {
  if (q.sparse) {
    return { kind: 'sparse', nonZero: q.sparse.indices.length, norm: round(Math.sqrt(q.sparse.values.reduce((a, x) => a + x * x, 0))), maxIndex: q.sparse.indices.length ? Math.max(...q.sparse.indices) : null };
  }
  const v = q.vector;
  if (!v?.length) return null;
  if (q.binary) return { kind: 'binary', bits: v.length, ones: v.reduce((a, x) => a + (x ? 1 : 0), 0) };
  const mean = v.reduce((a, x) => a + x, 0) / v.length;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return {
    kind: 'dense',
    dimension: v.length,
    norm: round(norm),
    mean: round(mean),
    variance: round(v.reduce((a, x) => a + (x - mean) ** 2, 0) / v.length),
    zeros: v.filter((x) => x === 0).length,
    normalised: Math.abs(norm - 1) < 1e-3,
  };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function scoreStats(results: Array<{ score: number }>): ScoreStats {
  const s = results.map((r) => r.score).filter((x) => Number.isFinite(x));
  if (!s.length) return { count: 0, max: null, min: null, mean: null, median: null, topGap: null, stdDev: null, topZ: null };
  const sorted = [...s].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / s.length);
  return {
    count: s.length,
    max: round(sorted[sorted.length - 1]),
    min: round(sorted[0]),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    median: round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    // Results come best first.
    topGap: s.length > 1 ? round(s[0] - s[1]) : null,
    stdDev: round(sd),
    topZ: sd > 1e-12 ? round((sorted[sorted.length - 1] - mean) / sd) : null,
  };
}

export interface Overlap {
  shared: number;
  onlyA: string[];
  onlyB: string[];
  /** |A ∩ B| / |A ∪ B|, 0-1. */
  jaccard: number;
  /** Records in both lists, with where each ranked (1 = top) and the move from A to B (positive = moved up in B). */
  rankShifts: Array<{ id: string; rankA: number; rankB: number; moved: number }>;
}

export function compareResults(a: Array<{ id: string }>, b: Array<{ id: string }>): Overlap {
  const rankA = new Map(a.map((r, i) => [r.id, i + 1]));
  const rankB = new Map(b.map((r, i) => [r.id, i + 1]));
  const shared = [...rankA.keys()].filter((id) => rankB.has(id));
  const union = new Set([...rankA.keys(), ...rankB.keys()]);
  return {
    shared: shared.length,
    onlyA: [...rankA.keys()].filter((id) => !rankB.has(id)),
    onlyB: [...rankB.keys()].filter((id) => !rankA.has(id)),
    jaccard: union.size ? round(shared.length / union.size) : 1,
    rankShifts: shared.map((id) => ({ id, rankA: rankA.get(id)!, rankB: rankB.get(id)!, moved: rankA.get(id)! - rankB.get(id)! })).sort((x, y) => x.rankA - y.rankA),
  };
}
