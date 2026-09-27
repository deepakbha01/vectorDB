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
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function scoreStats(results: Array<{ score: number }>): ScoreStats {
  const s = results.map((r) => r.score).filter((x) => Number.isFinite(x));
  if (!s.length) return { count: 0, max: null, min: null, mean: null, median: null, topGap: null };
  const sorted = [...s].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: s.length,
    max: round(sorted[sorted.length - 1]),
    min: round(sorted[0]),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    median: round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    // Results come best first.
    topGap: s.length > 1 ? round(s[0] - s[1]) : null,
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
