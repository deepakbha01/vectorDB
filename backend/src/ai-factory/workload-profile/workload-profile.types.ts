import { EvidenceType } from '../ai-factory.types';

export enum BusinessCriticality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  MISSION_CRITICAL = 'mission_critical',
}

export enum AiWorkloadType {
  GENAI = 'genai',
  RAG = 'rag',
  AGENTIC = 'agentic',
  COPILOT = 'copilot',
  CLASSIFICATION = 'classification',
  SUMMARIZATION = 'summarization',
  QUESTION_ANSWERING = 'question_answering',
  RECOMMENDATION = 'recommendation',
  SEARCH = 'search',
  MULTIMODAL = 'multimodal',
  OTHER = 'other',
}

export enum DataType {
  STRUCTURED = 'structured',
  UNSTRUCTURED = 'unstructured',
  DOCUMENTS = 'documents',
  IMAGES = 'images',
  AUDIO = 'audio',
  VIDEO = 'video',
  STREAMING = 'streaming',
  IOT = 'iot',
}

/** Named deployment targets (spec §4). "Hybrid" is derived: more than one target. */
export enum DeploymentTarget {
  ON_PREMISES = 'on_premises',
  AZURE = 'azure',
  AWS = 'aws',
  OCI = 'oci',
  GCP = 'gcp',
}

export type SizeTier = 'small' | 'medium' | 'large' | 'enterprise' | 'extreme_scale';
export type ArchitectureClass = 'rag' | 'agent' | 'copilot' | 'generative_ai' | 'search' | 'multimodal' | 'hybrid';
export type DataClassificationLevel = 'restricted' | 'confidential' | 'internal';

/** Where a resolved input value came from. */
export type InputSource = 'profile' | 'discovery' | 'project' | 'derived' | 'missing';

export interface ResolvedValue<T> {
  value: T | null;
  source: InputSource;
  /** e.g. "Discovery v2", "qps × 86,400". */
  detail?: string;
}

/** Every answer the profile is built from, after defaults from Discovery / the project were applied. */
export interface ResolvedProfileInputs {
  businessObjective: ResolvedValue<string>;
  businessDomain: ResolvedValue<string>;
  businessCriticality: ResolvedValue<BusinessCriticality>;
  expectedUsers: ResolvedValue<number>;
  numberOfApplications: ResolvedValue<number>;
  businessSla: ResolvedValue<string>;
  workloadTypes: ResolvedValue<AiWorkloadType[]>;
  dataSources: ResolvedValue<string[]>;
  dataTypes: ResolvedValue<DataType[]>;
  documentCount: ResolvedValue<number>;
  expectedVectorCount: ResolvedValue<number>;
  dailyRequests: ResolvedValue<number>;
  peakQps: ResolvedValue<number>;
  concurrentUsers: ResolvedValue<number>;
  dataGrowthPercentPerMonth: ResolvedValue<number>;
  targetLatencyMs: ResolvedValue<number>;
  targetTtftMs: ResolvedValue<number>;
  throughputRps: ResolvedValue<number>;
  availabilityTargetPercent: ResolvedValue<number>;
  deploymentTargets: ResolvedValue<DeploymentTarget[]>;
  hasGpu: ResolvedValue<boolean>;
  containsPii: ResolvedValue<boolean>;
  containsPhi: ResolvedValue<boolean>;
  containsPci: ResolvedValue<boolean>;
  confidentialData: ResolvedValue<boolean>;
  dataResidencyRequirement: ResolvedValue<string>;
  requiresEncryptionAtRest: ResolvedValue<boolean>;
  requiresEncryptionInTransit: ResolvedValue<boolean>;
  regulatoryRequirements: ResolvedValue<string>;
}

export interface SizeDriver {
  dimension: string;
  label: string;
  value: number;
  tier: SizeTier;
}

/** Spec §4 deliverable: the AI Workload Profile. */
export interface WorkloadProfileResult {
  status: 'complete' | 'incomplete';
  missingInputs: string[];
  workloadSize: { tier: SizeTier | null; drivers: SizeDriver[]; explanation: string };
  architecture: { class: ArchitectureClass | null; label: string | null; components: ArchitectureClass[]; explanation: string };
  scaleProfile: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  performanceProfile: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  dataClassification: { level: DataClassificationLevel; reasons: string[]; dataTypes: DataType[]; multimodal: boolean };
  deploymentRequirements: { targets: DeploymentTarget[]; hybrid: boolean; notes: string[] };
  securityRequirements: { controls: string[]; alreadyRequired: string[]; notes: string[] };
  assumptions: Array<{ statement: string; evidenceType: EvidenceType }>;
}
