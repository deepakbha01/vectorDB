/** Infrastructure Design (AI Factory Wave 5) - mirrors backend/src/ai-factory/infrastructure/*. */
import { Eligibility, EvidenceType, ScoreContribution } from './aiFactory';

export type TargetId = 'on_premises' | 'azure' | 'aws' | 'oci' | 'gcp';
export type PlatformKind = 'kubernetes' | 'vm' | 'managed' | 'saas' | 'in_app';
export type ComponentId = 'inference' | 'vector_database' | 'application';

export type FineTuningNeed = 'none' | 'adapter' | 'full';

/** Mirrors estateStorageVendors / estateHypervisors in backend config/infrastructure-targets.yaml. */
export const ESTATE_STORAGE_VENDORS: Record<string, string> = { netapp: 'NetApp', nutanix: 'Nutanix', dell_emc: 'Dell / EMC', vast_data: 'VAST Data', ddn: 'DDN', other: 'Other' };
export const ESTATE_HYPERVISORS: Record<string, string> = { vmware: 'VMware vSphere', nutanix_ahv: 'Nutanix AHV', hyper_v: 'Microsoft Hyper-V', none: 'None / bare metal' };
/** Mirrors hostCpus in backend config/infrastructure-targets.yaml. */
export type HostCpuId = 'x86' | 'grace' | 'vera';
export const HOST_CPUS: Record<HostCpuId, string> = { x86: 'x86-64 (Intel Xeon / AMD EPYC)', grace: 'NVIDIA Grace (Arm64)', vera: 'NVIDIA Vera (Arm64, preview)' };

export interface CreateInfrastructureDesignInput {
  hasKubernetes?: boolean;
  hasGpu?: boolean;
  multipleOnPremSites?: boolean;
  /** Data centre has direct-to-chip liquid cooling (rack-scale systems need it). */
  liquidCooling?: boolean;
  /** Most power one rack can draw, kW. */
  maxRackPowerKw?: number;
  /** Host CPU for on-premises CPU nodes; default x86. */
  hostCpu?: HostCpuId;
  existingStorageVendors?: string[];
  existingHypervisor?: string;
  fineTuning?: FineTuningNeed;
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

export interface OnPremStackResult {
  appliesTo: 'chosen' | 'if_on_premises';
  gpusSized: number;
  fineTuning: FineTuningNeed;
  chosen: StackCandidate | null;
  candidates: StackCandidate[];
  why: string;
  compute: string | null;
  platform: string | null;
  storagePlan: Array<{ tier: 'block' | 'file' | 'object' | 'parallel' | 'local_nvme'; purpose: string; product: string; sizeGb: number | null; basis: string }>;
  recovery: { modelLoadGbPerMinute: number; restoreGbPerMinute: number; modelLoadMinutes: number | null; restoreMinutes: number | null } | null;
  support: { contract: string; ownership: string; telemetry: string; practices: string[] } | null;
  benchmarkRequired: string[];
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
  /** Mandatory requirements the option meets (absent on results saved before it was added). */
  passed?: string[];
  score: number;
  /** Each criterion's value x weight, largest first (absent on older results). */
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
  sections: Record<'compute' | 'memory' | 'storage' | 'network' | 'cluster' | 'availability' | 'disasterRecovery' | 'scaling' | 'security', string[]>;
  sizing: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  wouldChangeIf: string[];
  benchmarkRequired: string[];
  /** Wave 13 - null when on-premises is not allowed; absent on results saved before it. */
  onPremStack?: OnPremStackResult | null;
}

export interface InfraContext {
  allowedTargets: TargetId[];
  restrictedData: boolean;
  dataResidency: string | null;
  availabilityTargetPercent: number;
  rpoMinutes: number | null;
  rtoMinutes: number | null;
  hasKubernetes: boolean | null;
  hasGpu: boolean | null;
  multipleOnPremSites: boolean;
  opsCapability: string;
  components: Array<{ id: ComponentId; label: string; platforms: PlatformKind[]; gpuLabel: string | null; detail: string }>;
  estate?: { storageVendors: string[]; hypervisor: string | null; fineTuning: FineTuningNeed };
  /** Set when the recommended GPU is only sold as a rack-scale system; absent on older contexts. */
  inference?: { rackSystem?: { label: string; gpusPerRack: number; racks: number; cpuLabel: string; cpusPerRack: number; rackPowerKw: number; rackPowerEstimated: boolean; cooling: 'liquid' | 'air' } | null } | null;
  facility?: { liquidCooling: boolean | null; maxRackPowerKw: number | null };
  hostCpu?: HostCpuId;
}

export type InfraSources = Record<string, { source: string; detail: string }>;

export interface InfrastructureDesign {
  id: string;
  version: number;
  submitted: CreateInfrastructureDesignInput;
  context: InfraContext;
  sources: InfraSources;
  result: InfrastructureResult;
  createdAt: string;
}

export interface InfrastructureDefaults {
  context: InfraContext;
  sources: InfraSources;
  preview: InfrastructureResult;
}
