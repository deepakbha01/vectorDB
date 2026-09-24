/**
 * The DR tier a design implies, from Discovery - shared by Cost & FinOps
 * (what DR costs) and the Operations model (how long recovery takes), so the
 * two can never disagree.
 */
export function drTier(
  d: { requiresMultiRegion?: boolean; regionalFailoverRequired?: boolean; rtoMinutes?: number | null } | null,
  warmStandbyRtoMinutes: number,
): { tier: 'cold' | 'warm' | 'active'; reason: string } {
  const rto = d?.rtoMinutes ?? null;
  if (d?.requiresMultiRegion) return { tier: 'active', reason: 'multi-region required (Discovery)' };
  if (d?.regionalFailoverRequired) return { tier: 'warm', reason: 'regional failover required (Discovery)' };
  if (rto !== null && rto <= warmStandbyRtoMinutes) return { tier: 'warm', reason: `RTO ${rto} min (Discovery)` };
  return { tier: 'cold', reason: rto !== null ? `RTO ${rto} min allows restore from backup (Discovery)` : 'no RTO stated - assumed restore from backup' };
}
