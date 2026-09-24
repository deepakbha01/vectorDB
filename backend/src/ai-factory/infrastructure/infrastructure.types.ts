import { Eligibility, EvidenceType } from '../ai-factory.types';

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
  } | null;
  securityControls: string[];
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
  score: number;
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
}
