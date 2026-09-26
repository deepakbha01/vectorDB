/**
 * Token alerts (spec §14) - pure rule evaluation over a snapshot of one
 * project's live usage. No I/O: the service gathers the snapshot and stores
 * what fires. A rule without the data it needs stays silent and says why.
 */

export type AlertSeverity = 'warning' | 'critical';
export type AlertRuleKey = 'budget' | 'spike' | 'tokensPerRequest' | 'unexpectedModel' | 'agentLoops' | 'ragContextGrowth' | 'costIncrease';

export interface AlertCatalogue {
  evaluateEveryMinutes: number;
  rules: {
    budget: { warningShare: number; criticalShare: number };
    spike: { baselineDays: number; factor: number; minTokens: number };
    tokensPerRequest: { lookbackHours: number; factorOfEstimate: number; minRequests: number };
    unexpectedModel: { lookbackHours: number; baselineDays: number; allowed: string[] };
    agentLoops: { lookbackHours: number; criticalTasks: number };
    ragContextGrowth: { lookbackHours: number; baselineDays: number; factor: number; minRequests: number };
    costIncrease: { baselineDays: number; factor: number; minCostUsd: number };
  };
}

/** Everything the rules read, for one project, measured on live usage. */
export interface AlertSnapshot {
  currency: string;
  budget: { monthlyUsd: number; source: string | null } | null;
  month: { costToDate: number; elapsedDays: number; daysInMonth: number };
  spike: { lastHourTokens: number; baselineHourlyTokens: number; baselineHours: number };
  tokensPerRequest: { requests: number; tokens: number; estimate: number | null; estimateVersion: number | null };
  models: { recent: Array<{ provider: string; model: string; tokens: number }>; seenBefore: string[]; expected: string[]; hasHistory: boolean };
  agents: { threshold: number; overLimit: Array<{ agentId: string; tasks: number; maxLlmCalls: number }> };
  ragContext: { recent: { requests: number; contextTokens: number }; baseline: { requests: number; contextTokens: number } };
  cost: { lastDay: number; baselineDailyAvg: number; baselineDays: number };
}

export interface Firing {
  rule: AlertRuleKey;
  /** Identifies "the same problem" across evaluations, e.g. one alert per unexpected model. */
  dedupeKey: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  metric: { observed: number; threshold: number; baseline?: number | null; unit: string };
}

export interface Evaluation {
  firing: Firing[];
  /** Rules that could not run and why - shown, never silently skipped. */
  silent: Array<{ rule: AlertRuleKey; reason: string }>;
}

const money = (n: number, c: string) => `${c === 'USD' ? '$' : `${c} `}${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 0 })}`;
const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function evaluateRules(s: AlertSnapshot, cat: AlertCatalogue): Evaluation {
  const firing: Firing[] = [];
  const silent: Evaluation['silent'] = [];
  const r = cat.rules;

  // 1. Budget - actual and projected spend this month.
  if (!s.budget || s.budget.monthlyUsd <= 0) silent.push({ rule: 'budget', reason: 'No monthly budget recorded (Discovery or Inference).' });
  else {
    const b = s.budget.monthlyUsd;
    const projected = s.month.elapsedDays > 0 ? (s.month.costToDate / s.month.elapsedDays) * s.month.daysInMonth : 0;
    // The worse of spend so far and spend projected to month end.
    const share = Math.max(s.month.costToDate, projected) / b;
    if (share >= r.budget.warningShare) {
      const critical = share >= r.budget.criticalShare;
      firing.push({
        rule: 'budget',
        dedupeKey: 'budget',
        severity: critical ? 'critical' : 'warning',
        title: s.month.costToDate >= b ? 'Token budget exceeded' : critical ? 'Token spend projected to exceed the budget' : 'Token spend approaching the budget',
        detail: `${money(s.month.costToDate, s.currency)} spent this month; at this rate ${money(projected, s.currency)} by month end, against a ${money(b, s.currency)} budget (${pct(share)})${s.budget.source ? ` - ${s.budget.source}` : ''}.`,
        metric: { observed: Math.round(projected * 100) / 100, threshold: b * (critical ? r.budget.criticalShare : r.budget.warningShare), unit: s.currency },
      });
    }
  }

  // 2. Sudden spike - last hour against the average hour before it.
  if (s.spike.baselineHours < 24) silent.push({ rule: 'spike', reason: 'Less than a day of usage history to compare against.' });
  else if (s.spike.lastHourTokens >= r.spike.minTokens && s.spike.baselineHourlyTokens > 0 && s.spike.lastHourTokens >= s.spike.baselineHourlyTokens * r.spike.factor) {
    const ratio = s.spike.lastHourTokens / s.spike.baselineHourlyTokens;
    firing.push({
      rule: 'spike',
      dedupeKey: 'spike',
      severity: ratio >= r.spike.factor * 2 ? 'critical' : 'warning',
      title: `Token spike: ${ratio.toFixed(1)}× the usual hourly volume`,
      detail: `${fmt(s.spike.lastHourTokens)} tokens in the last hour against an average of ${fmt(s.spike.baselineHourlyTokens)} per hour over the previous ${r.spike.baselineDays} days.`,
      metric: { observed: s.spike.lastHourTokens, threshold: Math.round(s.spike.baselineHourlyTokens * r.spike.factor), baseline: Math.round(s.spike.baselineHourlyTokens), unit: 'tokens / hour' },
    });
  }

  // 3. Tokens per request above what the design expects.
  const tpr = s.tokensPerRequest;
  if (tpr.estimate === null) silent.push({ rule: 'tokensPerRequest', reason: 'No saved token estimate to compare against.' });
  else if (tpr.requests < r.tokensPerRequest.minRequests) silent.push({ rule: 'tokensPerRequest', reason: `Fewer than ${r.tokensPerRequest.minRequests} requests in the last ${r.tokensPerRequest.lookbackHours} h.` });
  else {
    const observed = tpr.tokens / tpr.requests;
    const threshold = tpr.estimate * r.tokensPerRequest.factorOfEstimate;
    if (observed >= threshold) {
      firing.push({
        rule: 'tokensPerRequest',
        dedupeKey: 'tokensPerRequest',
        severity: observed >= threshold * 2 ? 'critical' : 'warning',
        title: `Tokens per request ${(observed / tpr.estimate).toFixed(1)}× the estimate`,
        detail: `${fmt(observed)} tokens per request over the last ${r.tokensPerRequest.lookbackHours} h (${fmt(tpr.requests)} requests) against ${fmt(tpr.estimate)} in estimate v${tpr.estimateVersion}.`,
        metric: { observed: Math.round(observed), threshold: Math.round(threshold), baseline: tpr.estimate, unit: 'tokens / request' },
      });
    }
  }

  // 4. Unexpected provider / model.
  const known = new Set([...s.models.seenBefore, ...s.models.expected, ...r.unexpectedModel.allowed].map((m) => m.toLowerCase()));
  // Without earlier usage every model would look new - stay silent until there is history.
  if (!s.models.hasHistory) silent.push({ rule: 'unexpectedModel', reason: `No usage before the last ${r.unexpectedModel.lookbackHours} h to compare against.` });
  else for (const m of s.models.recent) {
    const key = `${m.provider}/${m.model}`;
    if (known.has(key.toLowerCase())) continue;
    firing.push({
      rule: 'unexpectedModel',
      dedupeKey: `unexpectedModel:${key}`,
      severity: 'warning',
      title: `Unexpected model in use: ${key}`,
      detail: `${fmt(m.tokens)} tokens in the last ${r.unexpectedModel.lookbackHours} h on ${key}, which was not used in the previous ${r.unexpectedModel.baselineDays} days, is not in the estimate and is not in the allowed list.`,
      metric: { observed: m.tokens, threshold: 0, unit: 'tokens' },
    });
  }

  // 5. Excessive agent calls - possible loops.
  for (const a of s.agents.overLimit) {
    firing.push({
      rule: 'agentLoops',
      dedupeKey: `agentLoops:${a.agentId}`,
      severity: a.tasks >= r.agentLoops.criticalTasks ? 'critical' : 'warning',
      title: `Possible agent loop: ${a.agentId}`,
      detail: `${a.tasks} task(s) in the last ${r.agentLoops.lookbackHours} h made more than ${s.agents.threshold} LLM calls (up to ${a.maxLlmCalls}). Open the requests list sorted by tokens to see the traces.`,
      metric: { observed: a.maxLlmCalls, threshold: s.agents.threshold, unit: 'LLM calls / task' },
    });
  }

  // 6. RAG context-token growth.
  const rc = s.ragContext;
  if (rc.baseline.requests < r.ragContextGrowth.minRequests || rc.recent.requests < r.ragContextGrowth.minRequests) {
    silent.push({ rule: 'ragContextGrowth', reason: 'Too few RAG requests to compare context size.' });
  } else {
    const now = rc.recent.contextTokens / rc.recent.requests;
    const before = rc.baseline.contextTokens / rc.baseline.requests;
    if (before > 0 && now >= before * r.ragContextGrowth.factor) {
      firing.push({
        rule: 'ragContextGrowth',
        dedupeKey: 'ragContextGrowth',
        severity: 'warning',
        title: `RAG context grew ${(now / before).toFixed(1)}× per request`,
        detail: `${fmt(now)} retrieved-context tokens per request in the last ${r.ragContextGrowth.lookbackHours} h against ${fmt(before)} over the previous ${r.ragContextGrowth.baselineDays} days - check top-K, chunk size and reranking.`,
        metric: { observed: Math.round(now), threshold: Math.round(before * r.ragContextGrowth.factor), baseline: Math.round(before), unit: 'context tokens / request' },
      });
    }
  }

  // 7. Unexpected cost increase - last day against the average day.
  if (s.cost.baselineDays < 1) silent.push({ rule: 'costIncrease', reason: 'Less than a day of cost history to compare against.' });
  else if (s.cost.lastDay >= r.costIncrease.minCostUsd && s.cost.baselineDailyAvg > 0 && s.cost.lastDay >= s.cost.baselineDailyAvg * r.costIncrease.factor) {
    const ratio = s.cost.lastDay / s.cost.baselineDailyAvg;
    firing.push({
      rule: 'costIncrease',
      dedupeKey: 'costIncrease',
      severity: ratio >= r.costIncrease.factor * 2 ? 'critical' : 'warning',
      title: `Cost up ${ratio.toFixed(1)}× on the usual day`,
      detail: `${money(s.cost.lastDay, s.currency)} in the last 24 h against an average of ${money(s.cost.baselineDailyAvg, s.currency)} per day over the previous ${s.cost.baselineDays} day(s).`,
      metric: { observed: Math.round(s.cost.lastDay * 100) / 100, threshold: Math.round(s.cost.baselineDailyAvg * r.costIncrease.factor * 100) / 100, baseline: Math.round(s.cost.baselineDailyAvg * 100) / 100, unit: s.currency },
    });
  }

  return { firing, silent };
}

/**
 * How stored alerts change after an evaluation: open a new one, refresh one
 * that is still firing, resolve one that stopped. Pure, so the lifecycle is
 * testable without a database.
 */
export function reconcile(
  open: Array<{ id: string; dedupeKey: string }>,
  firing: Firing[],
): { create: Firing[]; refresh: Array<{ id: string; firing: Firing }>; resolve: string[] } {
  // Keep one open alert per problem; any duplicate (e.g. from before the unique index) is resolved.
  const byKey = new Map<string, string>();
  const duplicates: string[] = [];
  for (const a of open) {
    if (byKey.has(a.dedupeKey)) duplicates.push(a.id);
    else byKey.set(a.dedupeKey, a.id);
  }
  const firingKeys = new Set(firing.map((f) => f.dedupeKey));
  return {
    create: firing.filter((f) => !byKey.has(f.dedupeKey)),
    refresh: firing.filter((f) => byKey.has(f.dedupeKey)).map((f) => ({ id: byKey.get(f.dedupeKey)!, firing: f })),
    resolve: [...[...byKey].filter(([key]) => !firingKeys.has(key)).map(([, id]) => id), ...duplicates],
  };
}
