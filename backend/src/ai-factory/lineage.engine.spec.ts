import { computeLineage, hardDownstream, topologicalOrder } from './lineage.engine';
import { DeliverableVersion, PhaseDefinition, PhaseKey } from './ai-factory.types';

const graph: PhaseDefinition[] = [
  { key: 'discovery', label: 'Discovery', route: 'discovery', dependsOn: [] },
  { key: 'data_embeddings', label: 'Data', route: 'data-pipeline', dependsOn: [{ phase: 'discovery', kind: 'hard' }] },
  { key: 'index_design', label: 'Index', route: 'index-design', dependsOn: [{ phase: 'data_embeddings', kind: 'hard' }] },
  { key: 'vector_db_selection', label: 'VectorDB', route: 'vector-db-selection', dependsOn: [{ phase: 'discovery', kind: 'hard' }, { phase: 'index_design', kind: 'hard' }] },
  { key: 'inference', label: 'Inference', route: 'inference', dependsOn: [{ phase: 'discovery', kind: 'advisory' }] },
];

let clock = 0;
const v = (version: number): DeliverableVersion => ({ id: `id-${version}-${clock}`, version, createdAt: new Date(Date.UTC(2026, 0, 1) + ++clock * 60_000) });
const byPhase = (lineage: ReturnType<typeof computeLineage>) => Object.fromEntries(lineage.map((l) => [l.phase, l])) as Record<PhaseKey, (typeof lineage)[number]>;

describe('computeLineage', () => {
  beforeEach(() => (clock = 0));

  it('reports not_started for every phase of a new project', () => {
    const l = computeLineage(graph, {});
    expect(l.map((x) => x.status)).toEqual(['not_started', 'not_started', 'not_started', 'not_started', 'not_started']);
  });

  it('is current when every phase was built from the latest upstream', () => {
    const l = byPhase(computeLineage(graph, { discovery: [v(1)], data_embeddings: [v(1)], index_design: [v(1)], vector_db_selection: [v(1)], inference: [v(1)] }));
    expect(Object.values(l).map((x) => x.status)).toEqual(['current', 'current', 'current', 'current', 'current']);
    expect(l.vector_db_selection.upstream).toEqual([
      { phase: 'discovery', kind: 'hard', builtFromVersion: 1, latestVersion: 1, changedSinceBuilt: false },
      { phase: 'index_design', kind: 'hard', builtFromVersion: 1, latestVersion: 1, changedSinceBuilt: false },
    ]);
  });

  it('marks direct readers stale, propagates down hard edges, and only flags advisory readers for review', () => {
    const d1 = v(1), p1 = v(1), i1 = v(1), s1 = v(1), inf1 = v(1), d2 = v(2); // Discovery re-run after everything else
    const l = byPhase(computeLineage(graph, { discovery: [d1, d2], data_embeddings: [p1], index_design: [i1], vector_db_selection: [s1], inference: [inf1] }));

    expect(l.discovery.status).toBe('current');
    expect(l.data_embeddings).toMatchObject({ status: 'stale', reasons: [{ type: 'upstream_changed', phase: 'discovery' }] });
    expect(l.data_embeddings.upstream[0]).toMatchObject({ builtFromVersion: 1, latestVersion: 2, changedSinceBuilt: true });
    expect(l.index_design).toMatchObject({ status: 'stale', reasons: [{ type: 'upstream_stale', phase: 'data_embeddings' }] });
    expect(l.vector_db_selection.status).toBe('stale');
    expect(l.vector_db_selection.reasons.map((r) => r.type)).toEqual(['upstream_changed', 'upstream_stale']);
    expect(l.inference).toMatchObject({ status: 'review', reasons: [{ type: 'advisory_changed', phase: 'discovery' }] });
  });

  it('clears staleness once the phase is re-run after the upstream change', () => {
    const d1 = v(1), p1 = v(1), d2 = v(2), p2 = v(2);
    const l = byPhase(computeLineage(graph, { discovery: [d1, d2], data_embeddings: [p1, p2] }));
    expect(l.data_embeddings).toMatchObject({ status: 'current', reasons: [] });
    expect(l.data_embeddings.upstream[0]).toMatchObject({ builtFromVersion: 2, latestVersion: 2 });
  });

  it('flags a deliverable built before its upstream existed', () => {
    const d1 = v(1), s1 = v(1), i1 = v(1); // selection ran before any index design existed
    const l = byPhase(computeLineage(graph, { discovery: [d1], vector_db_selection: [s1], index_design: [i1], data_embeddings: [] }));
    expect(l.vector_db_selection.reasons).toEqual([expect.objectContaining({ type: 'built_before_upstream', phase: 'index_design' })]);
    expect(l.vector_db_selection.status).toBe('stale');
  });

  it('uses creation time, not insertion order, and counts versions', () => {
    const earlier = v(1), later = v(2);
    const l = byPhase(computeLineage(graph, { discovery: [later, earlier] })); // passed newest-first
    expect(l.discovery.latest?.version).toBe(2);
    expect(l.discovery.versions).toBe(2);
  });
});

describe('graph helpers', () => {
  it('orders upstream first', () => {
    const order = topologicalOrder(graph);
    expect(order.indexOf('discovery')).toBeLessThan(order.indexOf('data_embeddings'));
    expect(order.indexOf('index_design')).toBeLessThan(order.indexOf('vector_db_selection'));
  });

  it('rejects cycles and unknown phases', () => {
    const cyclic: PhaseDefinition[] = [
      { key: 'discovery', label: 'D', route: '', dependsOn: [{ phase: 'index_design', kind: 'hard' }] },
      { key: 'index_design', label: 'I', route: '', dependsOn: [{ phase: 'discovery', kind: 'hard' }] },
    ];
    expect(() => topologicalOrder(cyclic)).toThrow(/cycle/);
    expect(() => topologicalOrder([{ key: 'discovery', label: 'D', route: '', dependsOn: [{ phase: 'capacity', kind: 'hard' }] }])).toThrow(/Unknown phase 'capacity'/);
  });

  it('follows only hard edges downstream', () => {
    expect(hardDownstream(graph, 'discovery').sort()).toEqual(['data_embeddings', 'index_design', 'vector_db_selection']);
    expect(hardDownstream(graph, 'vector_db_selection')).toEqual([]);
  });
});
