import { EvidenceType } from '../ai-factory.types';
import {
  AiWorkloadType,
  ArchitectureClass,
  DataClassificationLevel,
  DataType,
  DeploymentTarget,
  ResolvedProfileInputs,
  ResolvedValue,
  SizeDriver,
  SizeTier,
  WorkloadProfileResult,
} from './workload-profile.types';

/** The workloadProfile section of config/ai-factory.yaml. */
export interface WorkloadProfileRules {
  sizeTiers: SizeTier[];
  sizeDimensions: Record<string, { label: string; bounds: number[] }>;
  architectureByWorkloadType: Record<string, ArchitectureClass | null>;
  multimodalDataTypes: DataType[];
  architectureLabels: Record<ArchitectureClass, string>;
  dataClassification: Record<'restricted' | 'confidential', string[]>;
  requiredControls: Record<DataClassificationLevel, string[]>;
  requiredInputs: string[];
}

const TARGET_LABELS: Record<DeploymentTarget, string> = { on_premises: 'On-premises', azure: 'Azure', aws: 'AWS', oci: 'OCI', gcp: 'GCP' };
const fmt = (n: number) => n.toLocaleString('en-US');

/** Values typed in by the customer are unverified until validated (spec §13); derived values are estimates. */
const evidenceOf = (v: ResolvedValue<unknown>): EvidenceType => (v.source === 'derived' ? 'estimated' : 'assumption');
const present = (v: ResolvedValue<unknown>) => v.value !== null && v.value !== undefined && !(Array.isArray(v.value) && v.value.length === 0) && v.value !== '';

export function classifySize(value: number, bounds: number[], tiers: SizeTier[]): SizeTier {
  const i = bounds.findIndex((b) => value < b);
  return tiers[i === -1 ? tiers.length - 1 : i];
}

/**
 * Builds the AI Workload Profile (spec §4). Pure: every rule comes from the
 * config, every value from the resolved inputs, and every classification
 * says which inputs drove it.
 */
export function buildWorkloadProfile(inp: ResolvedProfileInputs, rules: WorkloadProfileRules): WorkloadProfileResult {
  const missingInputs = rules.requiredInputs.filter((k) => !present((inp as unknown as Record<string, ResolvedValue<unknown>>)[k]));

  // ---- workload size: highest tier across answered dimensions
  const drivers: SizeDriver[] = Object.entries(rules.sizeDimensions)
    .map(([dimension, d]) => {
      const v = (inp as unknown as Record<string, ResolvedValue<number>>)[dimension]?.value;
      return typeof v === 'number' && v >= 0 ? { dimension, label: d.label, value: v, tier: classifySize(v, d.bounds, rules.sizeTiers) } : null;
    })
    .filter((d): d is SizeDriver => d !== null);
  const rank = (t: SizeTier) => rules.sizeTiers.indexOf(t);
  const top = drivers.reduce<SizeTier | null>((acc, d) => (acc === null || rank(d.tier) > rank(acc) ? d.tier : acc), null);
  const topDrivers = drivers.filter((d) => d.tier === top);
  const sizeExplanation = top
    ? `${label(top)} - driven by ${topDrivers.map((d) => `${d.label.toLowerCase()} (${fmt(d.value)})`).join(', ')}. The largest dimension sets the size so a single extreme dimension is never averaged away.`
    : 'Not enough scale answers to classify the workload size.';

  // ---- architecture class
  const types = inp.workloadTypes.value ?? [];
  const dataTypes = inp.dataTypes.value ?? [];
  const multimodal = types.includes(AiWorkloadType.MULTIMODAL) || dataTypes.some((t) => rules.multimodalDataTypes.includes(t));
  const components = [...new Set([...types.map((t) => rules.architectureByWorkloadType[t]).filter((c): c is ArchitectureClass => !!c), ...(multimodal ? ['multimodal' as const] : [])])];
  const archClass: ArchitectureClass | null = components.length === 0 ? null : components.length === 1 ? components[0] : 'hybrid';
  const archExplanation =
    archClass === null
      ? 'Select at least one AI workload type to classify the architecture.'
      : archClass === 'hybrid'
        ? `Hybrid - combines ${components.map((c) => rules.architectureLabels[c]).join(' + ')}${multimodal && !types.includes(AiWorkloadType.MULTIMODAL) ? ` (multimodal because the data includes ${dataTypes.filter((t) => rules.multimodalDataTypes.includes(t)).join(', ')})` : ''}.`
        : `${rules.architectureLabels[archClass]} - from the selected workload type(s): ${types.join(', ')}${multimodal && !types.includes(AiWorkloadType.MULTIMODAL) ? `; multimodal data (${dataTypes.filter((t) => rules.multimodalDataTypes.includes(t)).join(', ')})` : ''}.`;

  // ---- data classification: most sensitive level wins
  const flag = (k: string) => (inp as unknown as Record<string, ResolvedValue<boolean>>)[k]?.value === true;
  const flagLabel: Record<string, string> = { containsPhi: 'PHI (health data)', containsPci: 'PCI (payment card data)', containsPii: 'PII (personal data)', confidentialData: 'confidential business data' };
  let level: DataClassificationLevel = 'internal';
  let reasons: string[] = ['No PII, PHI, PCI or confidential data declared.'];
  for (const candidate of ['restricted', 'confidential'] as const) {
    const hits = rules.dataClassification[candidate].filter(flag);
    if (hits.length) {
      level = candidate;
      reasons = hits.map((h) => `Contains ${flagLabel[h] ?? h}.`);
      break;
    }
  }

  // ---- deployment requirements
  const targets = inp.deploymentTargets.value ?? [];
  const hybrid = targets.length > 1;
  const deploymentNotes: string[] = [];
  if (hybrid) deploymentNotes.push(`Hybrid across ${targets.map((t) => TARGET_LABELS[t]).join(' + ')} - components must be placed per target and connectivity between them designed explicitly.`);
  if (targets.length === 1 && targets[0] === DeploymentTarget.ON_PREMISES) deploymentNotes.push('On-premises only - fully managed cloud services and third-party model APIs will be treated as not eligible downstream unless this changes.');
  if (inp.dataResidencyRequirement.value) deploymentNotes.push(`Data residency "${inp.dataResidencyRequirement.value}" - every component, including model inference, must run inside this boundary.`);
  if (inp.hasGpu.value === false && types.some((t) => t !== AiWorkloadType.SEARCH && t !== AiWorkloadType.RECOMMENDATION)) {
    deploymentNotes.push('No GPU capacity available today - self-hosted model inference would need GPU provisioning, or a managed inference service.');
  }
  if (!targets.length) deploymentNotes.push('No deployment target selected yet.');

  // ---- security requirements
  const alreadyRequired = [
    ...(inp.requiresEncryptionAtRest.value ? ['Encryption at rest'] : []),
    ...(inp.requiresEncryptionInTransit.value ? ['Encryption in transit'] : []),
  ];
  const securityNotes: string[] = [];
  if (inp.regulatoryRequirements.value) securityNotes.push(`Regulatory scope: ${inp.regulatoryRequirements.value} - confirm every component's certification for it.`);
  if (level !== 'internal' && inp.requiresEncryptionAtRest.value === false) securityNotes.push(`Data is ${level} but encryption at rest was not marked as required in Discovery - reconcile before design.`);

  // ---- profiles and assumptions
  const row = (lbl: string, v: ResolvedValue<unknown>, render: (x: never) => string) =>
    present(v) ? [{ label: lbl, value: render(v.value as never) + (v.detail ? ` (${v.detail})` : ''), evidenceType: evidenceOf(v) }] : [];
  const num = (x: number) => fmt(x);
  const scaleProfile = [
    ...row('Documents', inp.documentCount, num),
    ...row('Vectors', inp.expectedVectorCount, num),
    ...row('Daily requests', inp.dailyRequests, num),
    ...(present(inp.dailyRequests) ? [{ label: 'Monthly requests', value: `${fmt(Math.round((inp.dailyRequests.value as number) * 30.4))} (daily × 30.4)`, evidenceType: 'estimated' as const }] : []),
    ...row('Peak QPS', inp.peakQps, num),
    ...row('Concurrent users', inp.concurrentUsers, num),
    ...row('Expected users', inp.expectedUsers, num),
    ...row('Applications', inp.numberOfApplications, num),
    ...row('Data growth', inp.dataGrowthPercentPerMonth, (x: number) => `${x}% / month`),
  ];
  const performanceProfile = [
    ...row('End-to-end latency target', inp.targetLatencyMs, (x: number) => `${fmt(x)} ms`),
    ...row('Time to first token target', inp.targetTtftMs, (x: number) => `${fmt(x)} ms`),
    ...row('Throughput', inp.throughputRps, (x: number) => `${fmt(x)} req/s`),
    ...row('Availability', inp.availabilityTargetPercent, (x: number) => `${x}%`),
    ...row('Business SLA', inp.businessSla, (x: string) => x),
  ];
  const assumptions = Object.entries(inp as unknown as Record<string, ResolvedValue<unknown>>)
    .filter(([, v]) => present(v) && (v.source === 'discovery' || v.source === 'project' || v.source === 'derived'))
    .map(([k, v]) => ({
      statement: `${k} = ${Array.isArray(v.value) ? (v.value as unknown[]).join(', ') : String(v.value)} - taken from ${v.detail ?? v.source}`,
      evidenceType: evidenceOf(v),
    }));

  return {
    status: missingInputs.length ? 'incomplete' : 'complete',
    missingInputs,
    workloadSize: { tier: top, drivers, explanation: sizeExplanation },
    architecture: { class: archClass, label: archClass ? rules.architectureLabels[archClass] : null, components, explanation: archExplanation },
    scaleProfile,
    performanceProfile,
    dataClassification: { level, reasons, dataTypes, multimodal },
    deploymentRequirements: { targets, hybrid, notes: deploymentNotes },
    securityRequirements: { controls: rules.requiredControls[level], alreadyRequired, notes: securityNotes },
    assumptions,
  };
}

function label(t: SizeTier): string {
  return t === 'extreme_scale' ? 'Extreme Scale' : t.charAt(0).toUpperCase() + t.slice(1);
}
