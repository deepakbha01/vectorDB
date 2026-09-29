/** One criterion's share of a weighted score: its 0-1 value times its weight. */
export interface ScoreContribution {
  criterion: string;
  value: number;
  weight: number;
  contribution: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The "why" behind a weighted score (spec §3: eligibility first, then scoring): each criterion's
 * value x weight, largest contribution first. The contributions sum to the score (within rounding).
 */
export function scoreBreakdown(criteria: Record<string, number>, weights: Record<string, number>): ScoreContribution[] {
  return Object.entries(criteria)
    .map(([criterion, value]) => ({ criterion, value: round(value), weight: weights[criterion] ?? 0, contribution: round(value * (weights[criterion] ?? 0)) }))
    .sort((a, b) => b.contribution - a.contribution);
}
