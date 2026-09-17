/**
 * Shared shape for every phase's "Executive Summary" translation of its
 * technical output into business language. Kept here (not inside any one
 * phase's module) since multiple phases produce one of these.
 */
export type FitRating = 'great' | 'ok' | 'weak';

export interface PlainLanguageScorecardRow {
  label: string;
  rating: FitRating;
  explanation: string;
}
