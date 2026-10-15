import { Eligibility, EvidenceType } from '../ai-factory.types';
import { ScoreContribution } from '../eligibility/score-breakdown';

export type TargetId = 'on_premises' | 'azure' | 'aws' | 'oci' | 'gcp';
export type PlatformKind = 'kubernetes' | 'vm' | 'managed' | 'saas' | 'in_app';
export type ComponentId = 'inference' | 'vector_database' | 'application';

export interface TargetSpec {
  label: string;
  platforms: Partial<Record<'kubernetes' | 'vm' | 'managed', string>>;
  gpus: string[];
  availabilityZones: boolean;
  multiRegion: boolean;
  privateNetworking: string;
  keyManagement: string;
  backup: string;
  elasticity: number;
  operationalSimplicity: number;
  dataControl: number;
}

export interface InfrastructureCatalogue {
  rulesVersion: string;
  targets: Record<TargetId, TargetSpec>;
  saasAvailability: Record<string, TargetId[]>;
  platformOpsRequirement: Record<PlatformKind, string>;
  opsCapabilityOrder: string[];
  scoringWeights: Record<'elasticity' | 'operationalSimplicity' | 'dataControl' | 'availability' | 'coLocation', number>;
  restrictedDataControlMultiplier: number;
  assumptions: { applicationNodes: number; applicationVcpusPerNode: number; modelVersionsKept: number; warmStandbyRtoMinutes: number };
  /** Host CPUs for on-premises CPU nodes (absent in older / test catalogues - then x86 is assumed and nothing is checked). */
  hostCpus?: Record<HostCpuId, HostCpuSpec>;
  arm64VectorPlatforms?: string[];
  /** Wave 13 on-premises reference stacks (absent in older / test catalogues - then no stack is recommended). */
  onPremStacks?: Record<string, OnPremStackSpec>;
  estateStorageVendors?: Record<string, string>;
  estateHypervisors?: Record<string, string>;
  stackScoringWeights?: Record<StackCriterion, number>;
  trainingThroughputMultiplier?: number;
  snapshotReserve?: number;
}

export type HostCpuId = 'x86' | 'grace' | 'vera';

export interface HostCpuSpec {
  label: string;
  arch: 'x86_64' | 'arm64';
  availability: 'ga' | 'preview';
  availabilityNote?: string;
}

export type StorageTier = 'block' | 'file' | 'object' | 'parallel';
export type StackCriterion = 'scaleFit' | 'estateReuse' | 'operationalSimplicity' | 'dataProtection' | 'throughput' | 'hybridCloud';
export type FineTuningNeed = 'none' | 'adapter' | 'full';

/** One on-premises compute + storage + platform reference stack (config/infrastructure-targets.yaml onPremStacks). */
export interface OnPremStackSpec {
  label: string;
  vendors: string[];
  hypervisors: string[];
  compute: string;
  platform: string;
  tiers: Record<StorageTier, string | null>;
  gpus: { min: number; sweetSpotMax: number; max: number | null };
  trainingCapable: boolean;
  opsRequirement: string;
  replication: { syncSupported: boolean; minAsyncRpoMinutes: number };
  cloudExtension: TargetId[];
  throughput: { modelLoadGbPerMinute: number; restoreGbPerMinute: number };
  ratings: { operationalSimplicity: number; throughput: number; cost: number };
  bestFor: string;
  support: { contract: string; ownership: string; telemetry: string };
}

/** What the customer already runs on-premises, and whether the stack must train. */
export interface OnPremEstate {
  storageVendors: string[];
  hypervisor: string | null;
  fineTuning: FineTuningNeed;
}

/** A component to place, with what it needs from a target. */
export interface ComponentNeed {
  id: ComponentId;
  label: string;
  platforms: PlatformKind[];
  /** GPU the sizing assumed; null when the component needs no GPU. */
  gpuId: string | null;
  gpuLabel: string | null;
  /** For fully managed SaaS vector databases. */
  saasId?: string;
  detail: string;
}

export interface InfraContext {
  allowedTargets: TargetId[];
  restrictedData: boolean;
  dataResidency: string | null;
  availabilityTargetPercent: number;
  haThreshold: number;
  rpoMinutes: number | null;
  rtoMinutes: number | null;
  requiresMultiRegion: boolean;
  regionalFailover: boolean;
  hasKubernetes: boolean | null;
  hasGpu: boolean | null;
  multipleOnPremSites: boolean;
  opsCapability: string;
  components: ComponentNeed[];
  vector: { platform: string; memoryGb: number; storageGb: number; cpuCores: number; forecastStorageGb: number | null; forecastHorizonMonths: number | null } | null;
  inference: {
    servingOption: string;
    managed: boolean;
    gpuLabel: string | null;
    gpuMemoryGb: number | null;
    totalGpusAtPeak: number | null;
    tensorParallel: number;
    replicas: { min: number; average: number; peak: number } | null;
    weightsGb: number | null;
    autoscaling: string | null;
    /** Set when the GPU is only sold as a rack-scale system; absent on older contexts. */
    rackSystem?: RackSystemFacts | null;
  } | null;
  securityControls: string[];
  /** Absent on contexts saved before Wave 13. */
  estate?: OnPremEstate;
  /** On-premises data-centre limits for rack-scale systems; absent on older contexts. */
  facility?: { liquidCooling: boolean | null; maxRackPowerKw: number | null };
  /** Host CPU for on-premises CPU nodes; absent on older contexts (= x86). */
  hostCpu?: HostCpuId;
}

/** A rack-scale system (e.g. GB300 NVL72) as Infrastructure Design needs it. */
export interface RackSystemFacts {
  label: string;
  gpusPerRack: number;
  /** Whole racks for the GPUs at peak. */
  racks: number;
  cpuLabel: string;
  cpusPerRack: number;
  rackPowerKw: number;
  rackPowerEstimated: boolean;
  cooling: 'liquid' | 'air';
}

/** What placement needs to know about each serving option (from config/serving.yaml). */
export interface ServingFacts {
  options: Array<{ id: string; requiresKubernetes: boolean; requiresGpu: boolean; managed: boolean }>;
}

export interface PlacementCandidate {
  component: ComponentId;
  target: TargetId;
  platform: PlatformKind;
  label: string;
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  /** Mandatory rules the placement meets - why it is eligible (absent on results saved before this was added). */
  passed?: string[];
  score: number;
  /** Each criterion's value x weight, largest first (absent on older saved results). */
  scoreBreakdown?: ScoreContribution[];
}

export interface Placement {
  component: ComponentId;
  componentLabel: string;
  chosen: PlacementCandidate | null;
  candidates: PlacementCandidate[];
  why: string;
}

export interface InfrastructureResult {
  rulesVersion: string;
  deploymentModel: { kind: 'single_target' | 'hybrid' | 'not_feasible'; targets: TargetId[]; summary: string };
  placements: Placement[];
  confidence: 'high' | 'medium' | 'low';
  sections: {
    compute: string[];
    memory: string[];
    storage: string[];
    network: string[];
    cluster: string[];
    availability: string[];
    disasterRecovery: string[];
    scaling: string[];
    security: string[];
  };
  sizing: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  wouldChangeIf: string[];
  benchmarkRequired: string[];
  /** Wave 13: on-premises stack recommendation; null when on-premises is not allowed (absent on older results). */
  onPremStack?: OnPremStackResult | null;
}

export interface StackCandidate {
  id: string;
  label: string;
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  passed: string[];
  score: number;
  scoreBreakdown: ScoreContribution[];
  bestFor: string;
  costRating: number;
}

export interface StoragePlanRow {
  tier: StorageTier | 'local_nvme';
  purpose: string;
  product: string;
  sizeGb: number | null;
  basis: string;
}

export interface OnPremStackResult {
  /** chosen: a component is placed on-premises; if_on_premises: on-premises is allowed but lost to a cloud target. */
  appliesTo: 'chosen' | 'if_on_premises';
  gpusSized: number;
  fineTuning: FineTuningNeed;
  chosen: StackCandidate | null;
  candidates: StackCandidate[];
  why: string;
  compute: string | null;
  platform: string | null;
  storagePlan: StoragePlanRow[];
  recovery: { modelLoadGbPerMinute: number; restoreGbPerMinute: number; modelLoadMinutes: number | null; restoreMinutes: number | null } | null;
  support: { contract: string; ownership: string; telemetry: string; practices: string[] } | null;
  benchmarkRequired: string[];
}
