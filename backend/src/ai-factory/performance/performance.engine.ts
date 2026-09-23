import { MetricDefinition, MetricGroup, MetricInputs, MetricResult, MetricStatus, PerformanceCatalogue, PerformanceContext, PerformanceResult } from './performance.types';

const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 1000) / 1000));
const withUnit = (n: number, unit: string) => `${fmt(n)}${unit ? (unit === '%' ? '%' : ` ${unit}`) : ''}`;

/** Does `value` meet `target` in the metric's direction? */
export const meets = (value: number, target: number, direction: MetricDefinition['direction']) => (direction === 'higher' ? value >= target : value <= target);

/** How far short of the target a value is, as a percentage of the target (0 when it meets it). */
export function shortfallPercent(value: number, target: number, direction: MetricDefinition['direction']): number {
  if (meets(value, target, direction) || target === 0) return 0;
  return (Math.abs(value - target) / Math.abs(target)) * 100;
}

/**
 * Spec §11 status for one metric. PASS / PASS WITH CONDITIONS / FAIL need a
 * measurement; without one the metric REQUIRES BENCHMARK, whatever the
 * estimate says. Pure.
 */
export function evaluateMetric(def: MetricDefinition, group: MetricGroup, x: MetricInputs, cat: PerformanceCatalogue): MetricResult {
  const base = { ...def, group, target: x.target, estimate: x.estimate, measured: x.measured };
  const estimateMeetsTarget = x.estimate && x.target ? meets(x.estimate.value, x.target.value, def.direction) : null;
  if (!x.applicable) {
    return { ...base, status: 'not_applicable', reasons: [x.notApplicableReason ?? 'Not part of this architecture.'], conditions: [], estimateMeetsTarget: null };
  }
  const reasons: string[] = [];
  const conditions: string[] = [];
  let status: MetricStatus;
  if (!x.measured) {
    status = 'requires_benchmark';
    reasons.push('No benchmark evidence yet - estimates are never reported as measured performance.');
    if (estimateMeetsTarget === false) reasons.push(`The ${x.estimate!.evidenceType.replace('_', '-')} figure (${withUnit(x.estimate!.value, def.unit)}) already misses the target (${withUnit(x.target!.value, def.unit)}) - expect a FAIL unless the design changes.`);
  } else if (!x.target) {
    status = 'pass_with_conditions';
    reasons.push(`Measured ${withUnit(x.measured.value, def.unit)}.`);
    conditions.push('No target set - agree one with the business before production.');
  } else {
    const gap = shortfallPercent(x.measured.value, x.target.value, def.direction);
    if (gap === 0) {
      status = 'pass';
      reasons.push(`Measured ${withUnit(x.measured.value, def.unit)} against a target of ${withUnit(x.target.value, def.unit)}.`);
    } else if (gap <= cat.conditionalMarginPercent) {
      status = 'pass_with_conditions';
      reasons.push(`Measured ${withUnit(x.measured.value, def.unit)} - ${gap.toFixed(1)}% short of ${withUnit(x.target.value, def.unit)}, within the ${cat.conditionalMarginPercent}% margin.`);
      conditions.push('Tune and re-measure before production.');
    } else {
      status = 'fail';
      reasons.push(`Measured ${withUnit(x.measured.value, def.unit)} - ${gap.toFixed(1)}% short of ${withUnit(x.target.value, def.unit)}.`);
    }
    if (x.target.assumed) {
      // A pass against a target nobody has agreed is not an unconditional pass.
      if (status === 'pass') status = 'pass_with_conditions';
      conditions.push(`Target is an assumption (${x.target.source}) - confirm it with the business.`);
    }
  }
  if (x.measured?.caveats.length && (status === 'pass' || status === 'pass_with_conditions')) {
    status = 'pass_with_conditions';
    conditions.push(...x.measured.caveats);
  } else if (x.measured?.caveats.length) {
    reasons.push(...x.measured.caveats);
  }
  return { ...base, status, reasons, conditions, estimateMeetsTarget };
}

/** Performance & Benchmark Assessment (spec §11). Pure. */
export function assessPerformance(ctx: PerformanceContext, cat: PerformanceCatalogue): PerformanceResult {
  const groups = cat.groups.map((g) => ({
    id: g.id,
    label: g.label,
    metrics: g.metrics.map((m) => evaluateMetric(m, g.id, ctx.metrics[m.id] ?? { applicable: false, notApplicableReason: 'No input for this metric.', target: null, estimate: null, measured: null }, cat)),
  }));
  const all = groups.flatMap((g) => g.metrics);
  const counts = { pass: 0, pass_with_conditions: 0, fail: 0, requires_benchmark: 0, not_applicable: 0 } as Record<MetricStatus, number>;
  for (const m of all) counts[m.status]++;

  const reasons: string[] = [];
  let status: PerformanceResult['status']['status'];
  if (counts.fail) {
    status = 'fail';
    reasons.push(...all.filter((m) => m.status === 'fail').map((m) => `${m.label}: ${m.reasons[0]}`));
  } else if (counts.requires_benchmark) {
    status = 'requires_benchmark';
    reasons.push(`${counts.requires_benchmark} metric(s) have no benchmark evidence yet.`);
    const warn = all.filter((m) => m.status === 'requires_benchmark' && m.estimateMeetsTarget === false);
    if (warn.length) reasons.push(`Estimates already miss the target for: ${warn.map((m) => m.label).join(', ')}.`);
  } else if (counts.pass_with_conditions) {
    status = 'pass_with_conditions';
    reasons.push(`${counts.pass_with_conditions} metric(s) pass only with conditions.`);
  } else {
    status = 'pass';
    reasons.push('Every applicable metric was measured and meets its target.');
  }

  return {
    rulesVersion: cat.rulesVersion,
    status: { status, label: cat.statusLabels[status], reasons },
    counts,
    groups,
    benchmarkPlan: all
      .filter((m) => m.status === 'requires_benchmark')
      .map((m) => ({ metric: `${m.label} (${cat.groups.find((g) => g.id === m.group)!.label})`, how: m.how, warning: m.estimateMeetsTarget === false ? 'Estimate already misses the target.' : null })),
    gaps: ctx.missingInputs.map((i) => `No ${i} yet - its metrics are not applicable until it exists.`),
  };
}
