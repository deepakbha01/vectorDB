import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AlertCatalogue, AlertSnapshot, evaluateRules, Firing, reconcile } from './alerts';

// The real thresholds from config/token-observability.yaml.
const CAT = (yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/token-observability.yaml'), 'utf8')) as { alerts: AlertCatalogue }).alerts;

/** A healthy project: every rule has its data and nothing fires. */
const healthy = (o: Partial<AlertSnapshot> = {}): AlertSnapshot => ({
  currency: 'USD',
  budget: { monthlyUsd: 10_000, source: 'Discovery v4' },
  month: { costToDate: 2_000, elapsedDays: 10, daysInMonth: 30 },
  spike: { lastHourTokens: 60_000, baselineHourlyTokens: 50_000, baselineHours: 168 },
  tokensPerRequest: { requests: 1_000, tokens: 8_000_000, estimate: 7_000, estimateVersion: 2 },
  models: { recent: [{ provider: 'openai', model: 'gpt-4o', tokens: 5_000_000 }], seenBefore: ['openai/gpt-4o'], expected: [], hasHistory: true },
  agents: { threshold: 5, overLimit: [] },
  ragContext: { recent: { requests: 500, contextTokens: 1_300_000 }, baseline: { requests: 3_000, contextTokens: 7_500_000 } },
  cost: { lastDay: 200, baselineDailyAvg: 190, baselineDays: 7 },
  ...o,
});
const rules = (f: Firing[]) => f.map((x) => `${x.rule}:${x.severity}`);

describe('evaluateRules (spec §14)', () => {
  it('fires nothing for a healthy project, and says which rules could not run', () => {
    const e = evaluateRules(healthy(), CAT);
    expect(e.firing).toEqual([]);
    expect(e.silent).toEqual([]);
  });

  describe('budget', () => {
    it('warns when projected spend reaches 80% of the budget', () => {
      // 2,700 in 10 days → 8,100 projected for the month.
      const e = evaluateRules(healthy({ month: { costToDate: 2_700, elapsedDays: 10, daysInMonth: 30 } }), CAT);
      expect(rules(e.firing)).toEqual(['budget:warning']);
      expect(e.firing[0].title).toBe('Token spend approaching the budget');
      expect(e.firing[0].detail).toMatch(/\$2,700 spent this month; at this rate \$8,100 by month end, against a \$10,000 budget \(81%\) - Discovery v4/);
    });

    it('is critical when the month is projected over budget, and says so once it is exceeded', () => {
      expect(evaluateRules(healthy({ month: { costToDate: 4_000, elapsedDays: 10, daysInMonth: 30 } }), CAT).firing[0]).toEqual(expect.objectContaining({ severity: 'critical', title: 'Token spend projected to exceed the budget' }));
      expect(evaluateRules(healthy({ month: { costToDate: 10_500, elapsedDays: 28, daysInMonth: 30 } }), CAT).firing[0].title).toBe('Token budget exceeded');
    });

    it('stays silent without a budget', () => {
      const e = evaluateRules(healthy({ budget: null, month: { costToDate: 1e6, elapsedDays: 1, daysInMonth: 30 } }), CAT);
      expect(e.firing).toEqual([]);
      expect(e.silent).toEqual([{ rule: 'budget', reason: 'No monthly budget recorded (Discovery or Inference).' }]);
    });
  });

  describe('spike', () => {
    it('fires at 3× the usual hour and is critical at 6×', () => {
      expect(rules(evaluateRules(healthy({ spike: { lastHourTokens: 160_000, baselineHourlyTokens: 50_000, baselineHours: 168 } }), CAT).firing)).toEqual(['spike:warning']);
      expect(rules(evaluateRules(healthy({ spike: { lastHourTokens: 310_000, baselineHourlyTokens: 50_000, baselineHours: 168 } }), CAT).firing)).toEqual(['spike:critical']);
    });

    it('ignores a small absolute volume and a project with less than a day of history', () => {
      expect(evaluateRules(healthy({ spike: { lastHourTokens: 40_000, baselineHourlyTokens: 1_000, baselineHours: 168 } }), CAT).firing).toEqual([]);
      const e = evaluateRules(healthy({ spike: { lastHourTokens: 1e7, baselineHourlyTokens: 1, baselineHours: 3 } }), CAT);
      expect(e.firing).toEqual([]);
      expect(e.silent.map((x) => x.rule)).toEqual(['spike']);
    });
  });

  describe('tokens per request', () => {
    it('fires at 1.5× the estimate', () => {
      const e = evaluateRules(healthy({ tokensPerRequest: { requests: 1_000, tokens: 11_000_000, estimate: 7_000, estimateVersion: 2 } }), CAT);
      expect(e.firing[0]).toEqual(expect.objectContaining({ rule: 'tokensPerRequest', severity: 'warning', title: 'Tokens per request 1.6× the estimate' }));
      expect(e.firing[0].metric).toEqual({ observed: 11_000, threshold: 10_500, baseline: 7_000, unit: 'tokens / request' });
    });

    it('needs an estimate and enough requests', () => {
      expect(evaluateRules(healthy({ tokensPerRequest: { requests: 1_000, tokens: 1e9, estimate: null, estimateVersion: null } }), CAT).silent[0].reason).toBe('No saved token estimate to compare against.');
      expect(evaluateRules(healthy({ tokensPerRequest: { requests: 5, tokens: 1e9, estimate: 7_000, estimateVersion: 2 } }), CAT).firing).toEqual([]);
    });
  });

  it('flags each unexpected model once, unless it was used before, is in the estimate or is allowed', () => {
    const models = { recent: [{ provider: 'openai', model: 'gpt-4o', tokens: 1 }, { provider: 'acme', model: 'x-large', tokens: 9_000 }, { provider: 'openai', model: 'text-embedding-3-small', tokens: 30 }], seenBefore: ['openai/gpt-4o'], expected: ['openai/text-embedding-3-small'], hasHistory: true };
    const e = evaluateRules(healthy({ models }), CAT);
    expect(e.firing.map((f) => f.dedupeKey)).toEqual(['unexpectedModel:acme/x-large']);
    expect(evaluateRules(healthy({ models }), { ...CAT, rules: { ...CAT.rules, unexpectedModel: { ...CAT.rules.unexpectedModel, allowed: ['ACME/x-large'] } } }).firing).toEqual([]);
  });

  it('stays silent about models on a project with no earlier usage', () => {
    const e = evaluateRules(healthy({ models: { recent: [{ provider: 'acme', model: 'x', tokens: 1 }], seenBefore: [], expected: [], hasHistory: false } }), CAT);
    expect(e.firing).toEqual([]);
    expect(e.silent.map((x) => x.rule)).toEqual(['unexpectedModel']);
  });

  it('raises one loop alert per agent, critical from 5 runaway tasks', () => {
    const e = evaluateRules(healthy({ agents: { threshold: 5, overLimit: [{ agentId: 'claims-agent', tasks: 1, maxLlmCalls: 14 }, { agentId: 'triage-agent', tasks: 6, maxLlmCalls: 9 }] } }), CAT);
    expect(e.firing.map((f) => [f.dedupeKey, f.severity])).toEqual([
      ['agentLoops:claims-agent', 'warning'],
      ['agentLoops:triage-agent', 'critical'],
    ]);
  });

  it('flags RAG context growth of 1.5× per request, given enough requests on both sides', () => {
    const grown = { recent: { requests: 500, contextTokens: 2_000_000 }, baseline: { requests: 3_000, contextTokens: 7_500_000 } };
    expect(evaluateRules(healthy({ ragContext: grown }), CAT).firing[0].title).toBe('RAG context grew 1.6× per request');
    expect(evaluateRules(healthy({ ragContext: { ...grown, baseline: { requests: 3, contextTokens: 10 } } }), CAT).firing).toEqual([]);
  });

  it('flags a day costing 1.5× the usual day, above a minimum', () => {
    expect(rules(evaluateRules(healthy({ cost: { lastDay: 300, baselineDailyAvg: 190, baselineDays: 7 } }), CAT).firing)).toEqual(['costIncrease:warning']);
    expect(rules(evaluateRules(healthy({ cost: { lastDay: 600, baselineDailyAvg: 190, baselineDays: 7 } }), CAT).firing)).toEqual(['costIncrease:critical']);
    expect(evaluateRules(healthy({ cost: { lastDay: 0.9, baselineDailyAvg: 0.1, baselineDays: 7 } }), CAT).firing).toEqual([]);
  });
});

describe('reconcile - the alert lifecycle', () => {
  const f = (dedupeKey: string): Firing => ({ rule: 'spike', dedupeKey, severity: 'warning', title: dedupeKey, detail: '', metric: { observed: 1, threshold: 1, unit: 'x' } });

  it('opens new alerts, refreshes the ones still firing and resolves the rest', () => {
    const r = reconcile(
      [
        { id: 'a1', dedupeKey: 'spike' },
        { id: 'a2', dedupeKey: 'budget' },
      ],
      [f('spike'), f('unexpectedModel:acme/x')],
    );
    expect(r.create.map((x) => x.dedupeKey)).toEqual(['unexpectedModel:acme/x']);
    expect(r.refresh.map((x) => x.id)).toEqual(['a1']);
    expect(r.resolve).toEqual(['a2']);
  });
});

describe('reconcile - duplicates (review fix)', () => {
  const f = (dedupeKey: string): Firing => ({ rule: 'budget', dedupeKey, severity: 'warning', title: dedupeKey, detail: '', metric: { observed: 1, threshold: 1, unit: 'x' } });

  it('keeps one open alert per problem and resolves the extra copies', () => {
    const r = reconcile(
      [
        { id: 'a1', dedupeKey: 'budget' },
        { id: 'a2', dedupeKey: 'budget' },
      ],
      [f('budget')],
    );
    expect(r.create).toEqual([]);
    expect(r.refresh.map((x) => x.id)).toEqual(['a1']);
    expect(r.resolve).toEqual(['a2']);
  });
});
