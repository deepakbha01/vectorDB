import { AffectedPhase, FieldChange, ImpactAnalysis, PhaseDefinition, PhaseKey } from './ai-factory.types';
import { hardDownstream, topologicalOrder } from './lineage.engine';

/** Compares values as the UI shows them: null/undefined/'' are "not set"; arrays compare order-insensitively. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === null || v === '') return null;
    if (Array.isArray(v)) return JSON.stringify([...v].map((x) => JSON.stringify(x)).sort());
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  };
  return norm(a) === norm(b);
}

/**
 * Spec §22 impact analysis between two Discovery assessment versions: which
 * answers changed, which phases read them directly, and - through the hard
 * dependency edges - everything downstream that must be re-run. Phases that
 * only take advisory suggestions are flagged for review, not re-run. Phases
 * with no dependency on the changes are listed as unaffected, with the reason.
 */
export function analyseImpact(
  phases: PhaseDefinition[],
  parameterImpact: Record<string, PhaseKey[]>,
  from: { version: number; values: Record<string, unknown> },
  to: { version: number; values: Record<string, unknown> },
): ImpactAnalysis {
  const changes: FieldChange[] = Object.keys(parameterImpact)
    .filter((field) => !sameValue(from.values[field], to.values[field]))
    .map((field) => ({ field, from: from.values[field] ?? null, to: to.values[field] ?? null, directPhases: parameterImpact[field] }));

  const label = (k: PhaseKey) => phases.find((p) => p.key === k)?.label ?? k;
  const because = new Map<PhaseKey, { action: 'rerun' | 'review'; reasons: string[] }>();
  const note = (k: PhaseKey, action: 'rerun' | 'review', reason: string) => {
    const cur = because.get(k) ?? { action, reasons: [] };
    if (action === 'rerun') cur.action = 'rerun';
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    because.set(k, cur);
  };

  // Discovery itself changed whenever any field did.
  if (changes.length) note('discovery', 'rerun', `${changes.length} answer(s) changed between v${from.version} and v${to.version}.`);

  for (const c of changes) {
    for (const k of c.directPhases) {
      const edge = phases.find((p) => p.key === k)?.dependsOn.find((d) => d.phase === 'discovery');
      note(k, edge?.kind === 'advisory' ? 'review' : 'rerun', `reads ${c.field} directly`);
    }
  }
  // Propagate re-runs downstream through hard edges (upstream-first so reasons chain correctly).
  for (const k of topologicalOrder(phases)) {
    if (because.get(k)?.action !== 'rerun' || k === 'discovery') continue;
    for (const d of hardDownstream(phases, k)) note(d, 'rerun', `built from ${label(k)}, which must be re-run`);
  }

  const affected: AffectedPhase[] = topologicalOrder(phases)
    .filter((k) => k !== 'discovery' && because.has(k))
    .map((k) => ({ phase: k, label: label(k), action: because.get(k)!.action, because: because.get(k)!.reasons }));

  const unaffected = phases
    .filter((p) => p.key !== 'discovery' && !because.has(p.key))
    .map((p) => ({ phase: p.key, label: p.label, reason: changes.length ? 'Does not read any of the changed answers, directly or through an upstream phase.' : 'No Discovery answers changed.' }));

  return {
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    affected,
    unaffected,
    noImpactFields: changes.filter((c) => c.directPhases.length === 0).map((c) => c.field),
  };
}
