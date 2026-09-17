/** Pure math helpers for the Phase 6 benchmark harness - kept dependency-free and independently testable. */

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Exact brute-force top-K by cosine similarity - the ground truth an ANN index is judged against. */
export function bruteForceTopK(query: number[], corpus: Array<{ id: string; vector: number[] }>, topK: number): string[] {
  return corpus
    .map((item) => ({ id: item.id, score: cosineSimilarity(query, item.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.id);
}

export function recallAtK(returnedIds: string[], groundTruthIds: string[]): number {
  if (groundTruthIds.length === 0) return 1;
  const groundTruthSet = new Set(groundTruthIds);
  const hits = returnedIds.filter((id) => groundTruthSet.has(id)).length;
  return hits / groundTruthIds.length;
}

/** Nearest-rank percentile (P50/P95/P99) over a set of latency samples in milliseconds. */
export function percentile(samplesMs: number[], p: number): number {
  if (samplesMs.length === 0) return 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

/** Deterministic, dependency-free unit vector generator for the synthetic benchmark corpus. */
export function syntheticUnitVector(seed: number, dimension: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const nextRandom = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vector = Array.from({ length: dimension }, () => nextRandom() * 2 - 1);
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / magnitude);
}
