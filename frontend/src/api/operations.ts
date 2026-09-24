/** Operations model (AI Factory Wave 10) - mirrors backend/src/ai-factory/operations/*. */

export type OnCallCoverage = 'none' | 'business_hours' | '24x7';
export const ON_CALL: Array<[OnCallCoverage, string]> = [
  ['none', 'None'],
  ['business_hours', 'Business hours'],
  ['24x7', '24x7'],
];

export interface CreateOperationsModelInput {
  onCallCoverage?: OnCallCoverage;
  drTested?: boolean;
}

export interface Statement {
  source: string;
  text: string;
}

export interface OperationsResult {
  rulesVersion: string;
  verdict: { status: 'pass_with_conditions' | 'further_assessment' | 'fail'; reasons: string[] };
  definitions: {
    rto: { tier: 'cold' | 'warm' | 'active'; targetMinutes: number | null; estimatedMinutes: number | null; meets: boolean | null; steps: Array<{ step: string; minutes: number }> };
    rpo: { targetMinutes: number | null; method: string; conditions: string[] };
    sla: { targetPercent: number; estimatedPercent: number | null; meets: boolean | null; components: Array<{ component: string; percent: number; basis: string }> };
    scalingPolicy: string[];
    failoverStrategy: string[];
    capacityThresholds: Array<{ metric: string; threshold: string; action: string; source: string }>;
  };
  areas: Array<{ area: string; label: string; status: 'from_design' | 'defined_here' | 'gap'; items: Statement[]; actions: string[] }>;
  operationalLoad: { items: Array<{ item: string; points: number }>; total: number; capacity: number; opsCapability: string; withinCapacity: boolean };
  gaps: string[];
  wouldChangeIf: string[];
  evidenceNote: string;
}

export interface OperationsModel {
  id: string;
  version: number;
  submitted: CreateOperationsModelInput;
  context: { opsCapability: string; availabilityTargetPercent: number; rpoMinutes: number | null; rtoMinutes: number | null; dr: { tier: string; reason: string }; onCallCoverage: OnCallCoverage | null; drTested: boolean };
  result: OperationsResult;
  createdAt: string;
}

export interface OperationsDefaults {
  context: OperationsModel['context'];
  sources: Record<string, { source: string; detail: string }>;
  preview: OperationsResult;
}
