import { DeliverableVersion, LineageStatus, PhaseDefinition, PhaseKey, PhaseLineage, StaleReason, UpstreamLink } from './ai-factory.types';

/** Last element (ES2021 target - no Array.prototype.at). */
const last = <T>(arr: T[]): T | null => (arr.length ? arr[arr.length - 1] : null);

/**
 * Infers lineage and staleness from deliverable timestamps alone.
 *
 * Every existing phase service builds from the LATEST upstream deliverable at
 * the moment it runs (getLatest), so the upstream version a deliverable was
 * built from is "the newest upstream version created at or before it". That
 * lets staleness be derived read-only - no hooks or extra writes in the
 * existing services.
 *
 * Staleness propagates down HARD edges: if Data & Embedding is stale, the
 * Index Design built from it is stale too. Advisory edges (pre-filled
 * suggestions) only produce a "review" hint.
 */
export function computeLineage(phases: PhaseDefinition[], histories: Partial<Record<PhaseKey, DeliverableVersion[]>>): PhaseLineage[] {
  const byKey = new Map(phases.map((p) => [p.key, p]));
  const sorted = (k: PhaseKey) => [...(histories[k] ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.version - b.version);
  const latestOf = (k: PhaseKey) => last(sorted(k));
  const result = new Map<PhaseKey, PhaseLineage>();

  for (const key of topologicalOrder(phases)) {
    const def = byKey.get(key)!;
    const latest = latestOf(key);
    const upstream: UpstreamLink[] = [];
    const reasons: StaleReason[] = [];

    for (const dep of def.dependsOn) {
      const depLatest = latestOf(dep.phase);
      const builtFrom = latest ? last(sorted(dep.phase).filter((v) => v.createdAt.getTime() <= latest.createdAt.getTime())) : null;
      const changedSinceBuilt = !!(latest && depLatest && (!builtFrom || depLatest.version !== builtFrom.version));
      upstream.push({ phase: dep.phase, kind: dep.kind, builtFromVersion: builtFrom?.version ?? null, latestVersion: depLatest?.version ?? null, changedSinceBuilt });
      if (!latest) continue;

      const depLabel = byKey.get(dep.phase)?.label ?? dep.phase;
      if (changedSinceBuilt && dep.kind === 'advisory') {
        reasons.push({ type: 'advisory_changed', phase: dep.phase, message: `${depLabel} changed since this was built (v${builtFrom?.version ?? '-'} → v${depLatest!.version}); suggested defaults may be out of date.` });
      } else if (changedSinceBuilt && !builtFrom) {
        reasons.push({ type: 'built_before_upstream', phase: dep.phase, message: `Built before ${depLabel} existed; ${depLabel} v${depLatest!.version} has not been taken into account.` });
      } else if (changedSinceBuilt) {
        reasons.push({ type: 'upstream_changed', phase: dep.phase, message: `Built from ${depLabel} v${builtFrom!.version}; the latest is v${depLatest!.version}.` });
      } else if (dep.kind === 'hard' && result.get(dep.phase)?.status === 'stale') {
        reasons.push({ type: 'upstream_stale', phase: dep.phase, message: `${depLabel} is itself out of date, so this result is too.` });
      }
    }

    let status: LineageStatus = 'not_started';
    if (latest) {
      status = reasons.some((r) => r.type !== 'advisory_changed') ? 'stale' : reasons.length ? 'review' : 'current';
    }
    result.set(key, { phase: key, label: def.label, route: def.route, status, latest, versions: histories[key]?.length ?? 0, upstream, reasons });
  }

  return phases.map((p) => result.get(p.key)!);
}

/** Upstream-first order; throws on a dependency cycle (a config error). */
export function topologicalOrder(phases: PhaseDefinition[]): PhaseKey[] {
  const byKey = new Map(phases.map((p) => [p.key, p]));
  const order: PhaseKey[] = [];
  const state = new Map<PhaseKey, 'visiting' | 'done'>();
  const visit = (k: PhaseKey, trail: PhaseKey[]) => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') throw new Error(`Dependency cycle in ai-factory.yaml: ${[...trail, k].join(' → ')}`);
    const def = byKey.get(k);
    if (!def) throw new Error(`Unknown phase '${k}' referenced in ai-factory.yaml (${trail.join(' → ')})`);
    state.set(k, 'visiting');
    for (const d of def.dependsOn) visit(d.phase, [...trail, k]);
    state.set(k, 'done');
    order.push(k);
  };
  for (const p of phases) visit(p.key, []);
  return order;
}

/** Every phase reachable downstream of `from` through hard edges (excluding `from`). */
export function hardDownstream(phases: PhaseDefinition[], from: PhaseKey): PhaseKey[] {
  const out = new Set<PhaseKey>();
  const walk = (k: PhaseKey) => {
    for (const p of phases) {
      if (!out.has(p.key) && p.dependsOn.some((d) => d.phase === k && d.kind === 'hard')) {
        out.add(p.key);
        walk(p.key);
      }
    }
  };
  walk(from);
  return [...out];
}
