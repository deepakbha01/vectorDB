import { compareResults, scoreStats } from './search-stats';
import { auditSummaries } from '../audit/audit-summarize';

describe('search statistics and A/B comparison', () => {
  it('summarises a score list (best first)', () => {
    expect(scoreStats([{ score: 0.9 }, { score: 0.7 }, { score: 0.5 }, { score: 0.4 }])).toEqual({ count: 4, max: 0.9, min: 0.4, mean: 0.625, median: 0.6, topGap: 0.2 });
    expect(scoreStats([])).toEqual({ count: 0, max: null, min: null, mean: null, median: null, topGap: null });
  });

  it('measures overlap and rank movement between two result lists', () => {
    const o = compareResults([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'c' }, { id: 'a' }, { id: 'd' }]);
    expect(o).toEqual({ shared: 2, onlyA: ['b'], onlyB: ['d'], jaccard: 0.5, rankShifts: [{ id: 'a', rankA: 1, rankB: 2, moved: -1 }, { id: 'c', rankA: 3, rankB: 1, moved: 2 }] });
  });

  it('keeps records out of the audit entry for a comparison, too', () => {
    const s = auditSummaries(
      '/api/projects/p/data-explorer/collections/docs/compare',
      { text: 'notice', a: { mode: 'dense', topK: 5 }, b: { mode: 'hybrid', alpha: 0.3, topK: 5 } },
      { a: { results: [{ id: 'x', metadata: { ssn: '123-45-6789' } }], latencyMs: 12 }, b: { results: [], latencyMs: 20 }, overlap: { shared: 0 } },
    );
    expect(s.responseSummary).toEqual({ a: { results: 1, latencyMs: 12 }, b: { results: 0, latencyMs: 20 }, shared: 0 });
    expect(JSON.stringify(s)).not.toContain('123-45-6789');
    expect(s.requestSummary).toEqual({ text: 'notice', a: { mode: 'dense', topK: 5 }, b: { mode: 'hybrid', alpha: 0.3, topK: 5 } });
  });
});
