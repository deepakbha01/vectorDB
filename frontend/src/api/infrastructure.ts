/** Infrastructure Design (AI Factory Wave 5) - mirrors backend/src/ai-factory/infrastructure/*. */
import { Eligibility, EvidenceType } from './aiFactory';

export type TargetId = 'on_premises' | 'azure' | 'aws' | 'oci' | 'gcp';
export type PlatformKind = 'kubernetes' | 'vm' | 'managed' | 'saas' | 'in_app';
export type ComponentId = 'inference' | 'vector_database' | 'application';

export interface CreateInfrastructureDesignInput {
  hasKubernetes?: boolean;
  hasGpu?: boolean;
  multipleOnPremSites?: boolean;
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
  sections: Record<'compute' | 'memory' | 'storage' | 'network' | 'cluster' | 'availability' | 'disasterRecovery' | 'scaling' | 'security', string[]>;
  sizing: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  wouldChangeIf: string[];
  benchmarkRequired: string[];
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
