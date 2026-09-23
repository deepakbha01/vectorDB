import { TargetId } from '../infrastructure/infrastructure.types';
import { CostCategory, CostLine, CostResource, FinopsCatalogue, FinopsContext, FinopsResult, OneOffCost, PricedOption } from './finops.types';

export const TARGET_LABELS: Record<TargetId, string> = { on_premises: 'On-premises', azure: 'Azure', aws: 'AWS', oci: 'OCI', gcp: 'GCP' };
const TARGETS: TargetId[] = ['on_premises', 'azure', 'aws', 'oci', 'gcp'];
const CATEGORIES: CostCategory[] = ['inference', 'vector_db', 'embedding', 'infrastructure', 'operations'];
const RESOURCES: CostResource[] = ['gpu', 'cpu', 'storage', 'network', 'api', 'people', 'other'];
const usd = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export const DISCLAIMER =
  'Directional planning estimates built from assumed unit rates and upstream sizing - not quotes and not guaranteed pricing. Replace the rate card with contracted prices or vendor quotes before budgeting.';

/** Where each component runs for one priced option. */
export type Assignment = { inference: TargetId; vector: TargetId; application: TargetId };

/**
 * Prices the architecture for one assignment of components to targets.
 * Returns the cost lines, or the reasons it cannot run there. Pure.
 */
export function priceAssignment(a: Assignment, ctx: FinopsContext, cat: FinopsCatalogue): { lines: CostLine[]; notFeasible: string[] } {
  const lines: CostLine[] = [];
  const notFeasible: string[] = [];
  const h = cat.hoursPerMonth;
  const add = (l: Omit<CostLine, 'monthlyUsd'> & { monthlyUsd: number }) => {
    if (l.monthlyUsd > 0) lines.push({ ...l, monthlyUsd: usd(l.monthlyUsd) });
  };
  const rate = (t: TargetId) => cat.targets[t];
  const rateNote = (t: TargetId) => `${TARGET_LABELS[t]} rate card (assumption, reviewed ${cat.lastReviewed})`;

  // ------------------------------------------------------------ inference
  const inf = ctx.inference;
  if (inf) {
    if (inf.mode === 'managed_api') {
      add({ category: 'inference', resource: 'api', item: `Managed API${inf.managedTierLabel ? ` (${inf.managedTierLabel})` : ''}`, monthlyUsd: inf.managedMonthlyUsd, evidenceType: 'estimated', basis: `${inf.source}: ${inf.tokensPerMonth.toLocaleString()} tokens / month at the tier's list price` });
    } else if (inf.gpuId && !ctx.gpuAvailability[a.inference]?.includes(inf.gpuId)) {
      notFeasible.push(`${inf.gpuLabel ?? inf.gpuId} is not offered on ${TARGET_LABELS[a.inference]} - re-size for a GPU it offers.`);
    } else {
      const r = rate(a.inference);
      const gpu = inf.gpuMonthlyListUsd * r.gpuFactor;
      add({ category: 'inference', resource: 'gpu', item: `GPUs - ${inf.gpusAtPeak ?? '?'} × ${inf.gpuLabel ?? 'GPU'} at peak`, monthlyUsd: gpu, evidenceType: 'estimated', basis: `${inf.source} list-price GPU spend × ${r.gpuFactor} (${rateNote(a.inference)})` });
      // The overhead covers serving storage (including model weights), networking, load balancing and observability - not priced again below.
      add({ category: 'inference', resource: 'other', item: `Serving overhead - ${inf.overheadPercent}% of GPU spend`, monthlyUsd: (gpu * inf.overheadPercent) / 100, evidenceType: 'assumption', basis: 'Storage incl. model weights, networking, load balancing, observability (config/inference.yaml)' });
      add({ category: 'inference', resource: 'people', item: 'Platform engineering for self-hosted serving', monthlyUsd: inf.platformFixedMonthlyUsd, evidenceType: 'assumption', basis: 'Fixed monthly cost (config/inference.yaml)' });
    }
  }

  // ------------------------------------------------------------ vector DB
  const v = ctx.vector;
  let vectorKind: string | null = null;
  if (v) {
    const onPrem = a.vector === 'on_premises';
    const kind = v.kinds.find((k) => (k === 'saas' ? !onPrem && (!v.saasTargets || v.saasTargets.includes(a.vector)) : k === 'managed' ? !onPrem : true)) ?? null;
    vectorKind = kind;
    if (!kind) {
      notFeasible.push(`${v.platform} is ${v.kinds.join(' / ')} only and cannot run on ${TARGET_LABELS[a.vector]}.`);
    } else if (kind === 'in_app') {
      add({ category: 'vector_db', resource: 'storage', item: `Embedded index storage - ${v.storageGb} GB`, monthlyUsd: v.storageGb * rate(a.application).blockStorageGbMonth, evidenceType: 'estimated', basis: `Runs inside the application; ${rateNote(a.application)}` });
    } else {
      const r = rate(a.vector);
      const p = cat.platformPremium[kind];
      const premium = p !== 1 ? ` × ${p} ${kind} premium (assumption)` : '';
      add({ category: 'vector_db', resource: 'cpu', item: `Compute - ${v.cpuCores} vCPU / ${v.memoryGb} GB × ${v.replicas} replica(s)`, monthlyUsd: (v.cpuCores * r.vcpuHour + v.memoryGb * r.ramGbHour) * h * v.replicas * p, evidenceType: 'estimated', basis: `${v.source}; ${v.replicaReason}; ${rateNote(a.vector)}${premium}` });
      add({ category: 'vector_db', resource: 'storage', item: `Storage - ${v.storageGb} GB × ${v.replicas} replica(s)`, monthlyUsd: v.storageGb * v.replicas * r.blockStorageGbMonth * p, evidenceType: 'estimated', basis: `${v.source}; ${rateNote(a.vector)}${premium}` });
      if (kind === 'vm' || kind === 'kubernetes') {
        add({ category: 'operations', resource: 'people', item: 'Self-managed vector database operations', monthlyUsd: cat.operations.selfManagedDbOpsMonthlyUsd, evidenceType: 'assumption', basis: '~0.1 FTE (assumption)' });
      }
      if (kind === 'saas') lines[lines.length - 1].basis += ' - SaaS pricing is vendor-specific; confirm with the vendor calculator';
    }
  }

  // ------------------------------------------------------------ embedding
  const e = ctx.embedding;
  if (e) {
    const monthlyTokens = e.monthlyNewTokens + e.monthlyQueryTokens;
    if (e.selfHosted) {
      const t = a.inference;
      add({ category: 'embedding', resource: 'gpu', item: `Embedding (self-hosted) - ${monthlyTokens.toLocaleString()} tokens / month`, monthlyUsd: (monthlyTokens / cat.embedding.selfHostedTokensPerSecPerGpu / 3600) * ctx.selfHostedEmbeddingGpuListHourly * rate(t).gpuFactor, evidenceType: 'estimated', basis: `${cat.embedding.selfHostedTokensPerSecPerGpu} tokens/s per ${cat.embedding.selfHostedGpuId.toUpperCase()} (assumption); ${rateNote(t)}` });
    } else {
      add({ category: 'embedding', resource: 'api', item: `Embedding API - ${monthlyTokens.toLocaleString()} tokens / month`, monthlyUsd: (monthlyTokens / 1e6) * e.pricePer1M, evidenceType: 'estimated', basis: `${e.source}: $${e.pricePer1M} per 1M tokens (catalogue list price); new documents + ${cat.embedding.avgQueryTokens}-token queries` });
    }
  }

  // ---------------------------------------------------- application / network
  const ar = rate(a.application);
  const vcpus = ctx.application.nodes * ctx.application.vcpusPerNode;
  add({ category: 'infrastructure', resource: 'cpu', item: `Application / gateway - ${ctx.application.nodes} × ${ctx.application.vcpusPerNode} vCPU`, monthlyUsd: vcpus * (ar.vcpuHour + cat.application.ramGbPerVcpu * ar.ramGbHour) * h, evidenceType: 'estimated', basis: `Node count is an assumption (Infrastructure Design); ${rateNote(a.application)}` });
  const egressGb = (ctx.requestsPerMonth * cat.network.responseKbPerRequest) / 1024 / 1024;
  add({ category: 'infrastructure', resource: 'network', item: `Egress to users - ~${egressGb.toFixed(1)} GB / month`, monthlyUsd: egressGb * ar.egressGb, evidenceType: 'estimated', basis: `${cat.network.responseKbPerRequest} KB per response (assumption); ${rateNote(a.application)}` });
  const targets = new Set([ctx.inference ? a.inference : null, ctx.vector && vectorKind !== 'in_app' ? a.vector : null, a.application].filter(Boolean));
  if (targets.size > 1) {
    const crossGb = (ctx.requestsPerMonth * cat.network.retrievalKbPerRequest) / 1024 / 1024;
    const payer = [...targets].find((t) => t !== 'on_premises') as TargetId | undefined;
    add({ category: 'infrastructure', resource: 'network', item: 'Hybrid interconnect (dedicated link)', monthlyUsd: cat.network.hybridInterconnectMonthlyUsd, evidenceType: 'assumption', basis: 'Port and circuit at both ends (assumption)' });
    add({ category: 'infrastructure', resource: 'network', item: `Cross-target traffic - ~${crossGb.toFixed(1)} GB / month`, monthlyUsd: crossGb * (payer ? rate(payer).egressGb : 0), evidenceType: 'estimated', basis: `${cat.network.retrievalKbPerRequest} KB retrieved context per request crossing targets (assumption)` });
  }

  // ----------------------------------------------------------- operations
  const infra = lines.filter((l) => l.resource !== 'api' && l.resource !== 'people').reduce((s, l) => s + l.monthlyUsd, 0);
  // Inference already carries its own observability in the serving overhead.
  const monitoredInfra = lines.filter((l) => l.resource !== 'api' && l.resource !== 'people' && l.category !== 'inference').reduce((s, l) => s + l.monthlyUsd, 0);
  const primary = a.application;
  add({ category: 'operations', resource: 'other', item: 'Monitoring and logging', monthlyUsd: (monitoredInfra * rate(primary).monitoringPercent) / 100, evidenceType: 'assumption', basis: `${rate(primary).monitoringPercent}% of non-inference infrastructure (assumption)` });
  const backupGb = (v && vectorKind ? v.storageGb : 0) + (inf?.mode === 'self_hosted' ? inf.weightsGb * ctx.modelVersionsKept : 0);
  const drFactor = cat.operations.drFactor[ctx.dr.tier];
  add({ category: 'operations', resource: 'storage', item: `Backup${drFactor === 0 ? ' (also the cold-DR copy)' : ''} - ${backupGb.toFixed(0)} GB × ${cat.operations.backupRetentionMultiplier}`, monthlyUsd: backupGb * cat.operations.backupRetentionMultiplier * rate(v ? a.vector : primary).objectStorageGbMonth, evidenceType: 'estimated', basis: `Vector storage and model weights to object storage; ${rateNote(v ? a.vector : primary)}` });
  add({ category: 'operations', resource: 'other', item: `Disaster recovery - ${ctx.dr.tier} standby`, monthlyUsd: infra * drFactor, evidenceType: 'assumption', basis: `${Math.round(drFactor * 100)}% of primary infrastructure (${ctx.dr.reason})` });
  add({ category: 'operations', resource: 'people', item: 'Vendor support', monthlyUsd: (infra * rate(primary).supportPercent) / 100, evidenceType: 'assumption', basis: `${rate(primary).supportPercent}% of infrastructure (assumption)` });

  return { lines, notFeasible };
}

function priced(id: PricedOption['id'], label: string, a: Assignment, allowed: boolean, ctx: FinopsContext, cat: FinopsCatalogue): PricedOption {
  const { lines, notFeasible } = priceAssignment(a, ctx, cat);
  const feasible = notFeasible.length === 0;
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, usd(lines.filter((l) => l.category === c).reduce((s, l) => s + l.monthlyUsd, 0))])) as Record<CostCategory, number>;
  return {
    id,
    label,
    targets: [...new Set([a.inference, a.vector, a.application])],
    allowed,
    feasible,
    notFeasibleReasons: notFeasible,
    monthlyUsd: feasible ? usd(lines.reduce((s, l) => s + l.monthlyUsd, 0)) : null,
    byCategory: feasible ? byCategory : null,
    lines: feasible ? lines : [],
  };
}

/** Cost & FinOps Assessment (spec §13). Pure. */
export function assessFinops(ctx: FinopsContext, cat: FinopsCatalogue): FinopsResult {
  const allowed = (ts: TargetId[]) => ts.every((t) => ctx.allowedTargets.includes(t));
  const single = TARGETS.map((t) => priced(t, TARGET_LABELS[t], { inference: t, vector: t, application: t }, allowed([t]), ctx, cat));
  const pl = ctx.placements;
  let chosen: PricedOption | null = null;
  let hybrid: PricedOption | null = null;
  if (pl && ctx.deploymentKind && ctx.deploymentKind !== 'not_feasible') {
    const app = pl.application ?? pl.inference ?? pl.vector_database!;
    const a: Assignment = { inference: pl.inference ?? app, vector: pl.vector_database ?? app, application: app };
    const label = ctx.deploymentKind === 'hybrid' ? `Chosen design (hybrid: ${[...new Set(Object.values(a))].map((t) => TARGET_LABELS[t]).join(' + ')})` : `Chosen design (${TARGET_LABELS[app]})`;
    chosen = priced('chosen', label, a, allowed(Object.values(a)), ctx, cat);
    if (ctx.deploymentKind === 'hybrid') hybrid = { ...chosen, id: 'hybrid', label: `Hybrid - ${chosen.label.replace(/^Chosen design \(hybrid: |\)$/g, '')}` };
  }
  const comparison = [...single, ...(hybrid ? [hybrid] : [])];
  const cheapest = comparison.filter((o) => o.allowed && o.feasible).sort((x, y) => x.monthlyUsd! - y.monthlyUsd!)[0] ?? null;

  const byResource = chosen?.feasible ? (Object.fromEntries(RESOURCES.map((r) => [r, usd(chosen!.lines.filter((l) => l.resource === r).reduce((s, l) => s + l.monthlyUsd, 0))])) as Record<CostResource, number>) : null;

  // Unit economics for the chosen design (or the inference assessment alone).
  const unitEconomics: FinopsResult['unitEconomics'] = [];
  const inf = ctx.inference;
  if (inf && inf.requestsPerMonth > 0) {
    const inferenceMonthly = chosen?.byCategory?.inference ?? (inf.mode === 'managed_api' ? inf.managedMonthlyUsd : inf.gpuMonthlyListUsd * (1 + inf.overheadPercent / 100) + inf.platformFixedMonthlyUsd);
    const basis = chosen?.byCategory ? `inference cost of the chosen design (${money(inferenceMonthly)} / month)` : `Inference assessment at list price (${money(inferenceMonthly)} / month)`;
    unitEconomics.push({ label: 'Inference cost / request', usd: inferenceMonthly / inf.requestsPerMonth, evidenceType: 'estimated', basis: `${basis} ÷ ${inf.requestsPerMonth.toLocaleString()} requests` });
    if (inf.tokensPerMonth > 0) {
      unitEconomics.push({ label: 'Inference cost / 1K tokens', usd: (inferenceMonthly / inf.tokensPerMonth) * 1e3, evidenceType: 'estimated', basis: `${basis} ÷ ${inf.tokensPerMonth.toLocaleString()} tokens` });
      unitEconomics.push({ label: 'Inference cost / 1M tokens', usd: (inferenceMonthly / inf.tokensPerMonth) * 1e6, evidenceType: 'estimated', basis: `${basis} ÷ ${inf.tokensPerMonth.toLocaleString()} tokens` });
    }
    if (chosen?.monthlyUsd) unitEconomics.push({ label: 'Total platform cost / request', usd: chosen.monthlyUsd / inf.requestsPerMonth, evidenceType: 'estimated', basis: `all categories (${money(chosen.monthlyUsd)} / month) ÷ requests` });
  }

  const oneOff: OneOffCost[] = [];
  const e = ctx.embedding;
  if (e) {
    const price = (tokens: number) =>
      e.selfHosted
        ? (tokens / cat.embedding.selfHostedTokensPerSecPerGpu / 3600) * ctx.selfHostedEmbeddingGpuListHourly * cat.targets[pl?.inference ?? 'aws'].gpuFactor
        : (tokens / 1e6) * e.pricePer1M;
    const how = e.selfHosted ? `GPU hours at ${cat.embedding.selfHostedTokensPerSecPerGpu} tokens/s (assumption)` : `$${e.pricePer1M} per 1M tokens (catalogue list price)`;
    oneOff.push({ item: `Initial embedding - ${e.corpusTokens.toLocaleString()} tokens`, usd: usd(price(e.corpusTokens)), evidenceType: 'estimated', basis: `${e.source}; ${how}` });
    oneOff.push({ item: `Re-embedding at ${cat.embedding.reembedHorizonMonths} months - ${e.reembedTokens.toLocaleString()} tokens`, usd: usd(price(e.reembedTokens)), evidenceType: 'estimated', basis: `Corpus grown at the Discovery growth rate; paid again on any embedding-model change; ${how}` });
  }

  // Budget
  const total = chosen?.monthlyUsd ?? null;
  let budget: FinopsResult['budget'];
  if (!ctx.monthlyBudgetUsd) budget = { monthlyBudgetUsd: null, source: null, status: 'no_budget', note: 'No monthly budget stated - agree one to validate cost.' };
  else if (total === null) budget = { monthlyBudgetUsd: ctx.monthlyBudgetUsd, source: ctx.budgetSource, status: 'no_budget', note: 'No priced design to compare against the budget yet.' };
  else {
    const over = ((total - ctx.monthlyBudgetUsd) / ctx.monthlyBudgetUsd) * 100;
    budget = {
      monthlyBudgetUsd: ctx.monthlyBudgetUsd,
      source: ctx.budgetSource,
      status: over <= 0 ? 'within_budget' : over <= cat.budget.withinMarginPercent ? 'near_budget' : 'exceeds_budget',
      note: over <= 0 ? `${money(total)} / month is ${Math.abs(over).toFixed(0)}% under the ${money(ctx.monthlyBudgetUsd)} budget.` : `${money(total)} / month is ${over.toFixed(0)}% over the ${money(ctx.monthlyBudgetUsd)} budget.`,
    };
  }

  const gaps = [...ctx.missing.map((m) => `No ${m} yet - its costs are not included.`)];
  if (!chosen) gaps.push('No Infrastructure Design yet - only whole-stack target comparisons are priced.');
  else if (!chosen.feasible) gaps.push(...chosen.notFeasibleReasons.map((r) => `Chosen design: ${r}`));

  const reasons: string[] = [];
  let status: FinopsResult['validation']['status'];
  if (budget.status === 'exceeds_budget') {
    status = 'fail';
    reasons.push(`Over budget: ${budget.note}`);
  } else if (!chosen?.feasible || budget.status === 'no_budget' || ctx.missing.length) {
    status = 'further_assessment';
    if (!chosen?.feasible) reasons.push('The chosen design is not priced yet.');
    if (budget.status === 'no_budget') reasons.push(budget.note);
    if (ctx.missing.length) reasons.push(`Missing inputs: ${ctx.missing.join(', ')}.`);
  } else {
    status = 'pass_with_conditions';
    reasons.push(budget.note, 'Every figure is an estimate or assumption - confirm with contracted rates or vendor quotes before committing.');
    if (budget.status === 'near_budget') reasons.push(`Within the ${cat.budget.withinMarginPercent}% margin - little headroom for growth.`);
  }

  const wouldChangeIf: string[] = [];
  if (cheapest && chosen?.monthlyUsd && cheapest.id !== 'chosen' && cheapest.id !== 'hybrid' && cheapest.monthlyUsd! < chosen.monthlyUsd * 0.9) {
    wouldChangeIf.push(`${cheapest.label} is ~${Math.round((1 - cheapest.monthlyUsd! / chosen.monthlyUsd) * 100)}% cheaper at these rates - revisit if the placement constraints allow it.`);
  }
  if (inf?.mode === 'self_hosted') wouldChangeIf.push('Committed-use / reserved GPU pricing typically lowers GPU spend materially versus on-demand.');
  if (ctx.dr.tier !== 'cold') wouldChangeIf.push(`A longer RTO would allow cold DR (restore from backup) instead of ${ctx.dr.tier} standby.`);
  wouldChangeIf.push('A customer rate card replaces every assumed unit price.');

  return {
    rulesVersion: cat.rulesVersion,
    ratesReviewed: cat.lastReviewed,
    disclaimer: DISCLAIMER,
    chosen,
    comparison,
    byResource,
    unitEconomics: unitEconomics.map((u) => ({ ...u, usd: Math.round(u.usd * 1e6) / 1e6 })),
    oneOff,
    budget,
    validation: { status, reasons },
    cheapestAllowed: cheapest ? { id: cheapest.id, label: cheapest.label, monthlyUsd: cheapest.monthlyUsd! } : null,
    gaps,
    wouldChangeIf,
  };
}
