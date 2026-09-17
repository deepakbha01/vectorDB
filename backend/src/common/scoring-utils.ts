/** Shared numeric helpers for the Recommendation and Index Design engines. */

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Linear ramp from 0 at `from` to 1 at `to` (handles `to < from` by inverting). */
export function ramp(value: number, from: number, to: number): number {
  if (from === to) {
    return value >= to ? 1 : 0;
  }
  return clamp01((value - from) / (to - from));
}

export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Explains why a losing option scored below the winner by naming the criterion
 * with the largest gap (>0.15), or falling back to "close alternative" when no
 * single criterion dominates the difference. Used by both the Recommendation
 * Engine (Phase 1) and Index Recommendation Engine (Phase 3) so alternatives
 * are explained the same way everywhere.
 */
export function buildComparativeReason(
  winnerLabel: string,
  winnerScore: number,
  winnerCriteria: Record<string, number>,
  optionLabel: string,
  optionScore: number,
  optionCriteria: Record<string, number>,
): string {
  const gaps = Object.keys(winnerCriteria)
    .map((criterion) => ({ criterion, gap: winnerCriteria[criterion] - optionCriteria[criterion] }))
    .filter((g) => g.gap > 0.15)
    .sort((a, b) => b.gap - a.gap);

  if (gaps.length === 0) {
    return `${optionLabel} scored ${optionScore.toFixed(2)} vs. ${winnerLabel}'s ${winnerScore.toFixed(2)} - a close alternative, revisit if requirements change.`;
  }
  return `${optionLabel} scored ${optionScore.toFixed(2)} vs. ${winnerLabel}'s ${winnerScore.toFixed(2)} - weakest on ${gaps[0].criterion} (gap ${gaps[0].gap.toFixed(2)}).`;
}
