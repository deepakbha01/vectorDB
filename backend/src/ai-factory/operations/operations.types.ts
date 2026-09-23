import { PlatformKind, TargetId } from '../infrastructure/infrastructure.types';

export type OperationsArea =
  | 'autoscaling'
  | 'load_balancing'
  | 'high_availability'
  | 'disaster_recovery'
  | 'backup'
  | 'failover'
  | 'model_versioning'
  | 'model_rollback'
  | 'observability'
  | 'alerting'
  | 'capacity_planning'
  | 'upgrade_strategy'
  | 'incident_management';
export type OnCallCoverage = 'none' | 'business_hours' | '24x7';
export type DrTier = 'cold' | 'warm' | 'active';

export interface OperationsCatalogue {
  rulesVersion: string;
  componentAvailability: { singleReplica: number; managedService: number; managedApi: number };
  siteAvailability: { onPremSingleSite: number; onPremMultiSite: number; cloudRegion: number };
  recovery: {
    provisioningMinutes: { cloud: number; on_premises: number };
    restoreGbPerMinute: number;
    modelLoadGbPerMinute: number;
    validationMinutes: number;
    warmFailoverMinutes: number;
    activeFailoverMinutes: number;
  };
  backup: { snapshotIntervalMinutes: number; continuousReplicationRpoMinutes: number };
  capacityThresholds: { vectorMemoryPercent: number; storagePercent: number; cpuPercent: number };
  operationalLoad: {
    points: Record<'selfHostedGpuServing' | 'buildKubernetes' | 'selfManagedVectorDb' | 'agentsThatAct' | 'hybrid' | 'standbyDr', number>;
    capacity: Record<string, number>;
  };
  onCallAvailabilityThreshold: number;
}

export interface Statement {
  source: string;
  text: string;
}

/** What the operations model is built from - resolved from the upstream records. */
export interface OperationsContext {
  availabilityTargetPercent: number;
  rpoMinutes: number | null;
  rtoMinutes: number | null;
  opsCapability: string;
  onCallCoverage: OnCallCoverage | null;
  drTested: boolean;
  dr: { tier: DrTier; reason: string };
  deployment: { targets: TargetId[]; kind: 'single_target' | 'hybrid'; multipleOnPremSites: boolean; hasKubernetes: boolean | null } | null;
  inference: { managed: boolean; minReplicas: number; weightsGb: number; servingLabel: string; gpuUtilizationTarget: number | null; ttftTargetMs: number | null } | null;
  vector: { platform: string; kinds: PlatformKind[]; storageGb: number; memoryGb: number; replicas: number } | null;
  models: { primary: string; secondary: string | null; fallback: string | null } | null;
  modelVersionsKept: number;
  agentActs: boolean;
  capacity: { version: number; horizons: Array<{ months: number; storageGb: number; memoryGb: number; triggers: string[] }>; sharding: string } | null;
  /** Upstream statements per area (Inference Architecture, Infrastructure Design, Capacity plan, RAG / Agent). */
  statements: Partial<Record<OperationsArea, Statement[]>>;
  missing: string[];
}

export interface AvailabilityEstimate {
  targetPercent: number;
  estimatedPercent: number | null;
  meets: boolean | null;
  components: Array<{ component: string; percent: number; basis: string }>;
}

export interface RecoveryEstimate {
  tier: DrTier;
  targetMinutes: number | null;
  estimatedMinutes: number | null;
  meets: boolean | null;
  steps: Array<{ step: string; minutes: number }>;
}

export interface RpoPlan {
  targetMinutes: number | null;
  method: string;
  conditions: string[];
}

export interface AreaResult {
  area: OperationsArea;
  label: string;
  status: 'from_design' | 'defined_here' | 'gap';
  items: Statement[];
  actions: string[];
}

export interface OperationsResult {
  rulesVersion: string;
  verdict: { status: 'pass_with_conditions' | 'further_assessment' | 'fail'; reasons: string[] };
  definitions: {
    rto: RecoveryEstimate;
    rpo: RpoPlan;
    sla: AvailabilityEstimate;
    scalingPolicy: string[];
    failoverStrategy: string[];
    capacityThresholds: Array<{ metric: string; threshold: string; action: string; source: string }>;
  };
  areas: AreaResult[];
  operationalLoad: { items: Array<{ item: string; points: number }>; total: number; capacity: number; opsCapability: string; withinCapacity: boolean };
  gaps: string[];
  wouldChangeIf: string[];
  evidenceNote: string;
}
