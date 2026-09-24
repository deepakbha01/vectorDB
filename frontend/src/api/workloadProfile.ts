/** AI Workload Profile (AI Factory Wave 2) - mirrors backend/src/ai-factory/workload-profile/*. */
import { EvidenceType } from './aiFactory';

export type BusinessCriticality = 'low' | 'medium' | 'high' | 'mission_critical';
export type AiWorkloadType = 'genai' | 'rag' | 'agentic' | 'copilot' | 'classification' | 'summarization' | 'question_answering' | 'recommendation' | 'search' | 'multimodal' | 'other';
export type DataType = 'structured' | 'unstructured' | 'documents' | 'images' | 'audio' | 'video' | 'streaming' | 'iot';
export type DeploymentTarget = 'on_premises' | 'azure' | 'aws' | 'oci' | 'gcp';

export const WORKLOAD_TYPES: Array<[AiWorkloadType, string]> = [
  ['genai', 'Generative AI'],
  ['rag', 'RAG'],
  ['agentic', 'Agentic AI'],
  ['copilot', 'Copilot'],
  ['question_answering', 'Question answering'],
  ['summarization', 'Summarisation'],
  ['classification', 'Classification'],
  ['search', 'Search'],
  ['recommendation', 'Recommendation'],
  ['multimodal', 'Multimodal'],
  ['other', 'Other'],
];
export const DATA_TYPES: Array<[DataType, string]> = [
  ['documents', 'Documents'],
  ['unstructured', 'Unstructured text'],
  ['structured', 'Structured / tables'],
  ['images', 'Images'],
  ['audio', 'Audio'],
  ['video', 'Video'],
  ['streaming', 'Streaming'],
  ['iot', 'IoT'],
];
export const DEPLOYMENT_TARGETS: Array<[DeploymentTarget, string]> = [
  ['on_premises', 'On-premises'],
  ['azure', 'Azure'],
  ['aws', 'AWS'],
  ['oci', 'OCI'],
  ['gcp', 'GCP'],
];

export interface CreateWorkloadProfileInput {
  businessObjective: string;
  businessDomain?: string;
  businessCriticality: BusinessCriticality;
  expectedUsers?: number;
  numberOfApplications?: number;
  businessSla?: string;
  workloadTypes: AiWorkloadType[];
  dataSources?: string[];
  dataTypes?: DataType[];
  documentCount?: number;
  expectedVectorCount?: number;
  dailyRequests?: number;
  peakQps?: number;
  concurrentUsers?: number;
  dataGrowthPercentPerMonth?: number;
  targetLatencyMs?: number;
  targetTtftMs?: number;
  throughputRps?: number;
  availabilityTargetPercent?: number;
  deploymentTargets: DeploymentTarget[];
  containsPii?: boolean;
  containsPhi?: boolean;
  containsPci?: boolean;
  confidentialData?: boolean;
  dataResidencyRequirement?: string;
  regulatoryRequirements?: string;
}

export interface ResolvedValue<T = unknown> {
  value: T | null;
  source: 'profile' | 'discovery' | 'project' | 'derived' | 'missing';
  detail?: string;
}

export interface WorkloadProfileResult {
  status: 'complete' | 'incomplete';
  missingInputs: string[];
  workloadSize: { tier: string | null; drivers: Array<{ dimension: string; label: string; value: number; tier: string }>; explanation: string };
  architecture: { class: string | null; label: string | null; components: string[]; explanation: string };
  scaleProfile: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  performanceProfile: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  dataClassification: { level: 'restricted' | 'confidential' | 'internal'; reasons: string[]; dataTypes: DataType[]; multimodal: boolean };
  deploymentRequirements: { targets: DeploymentTarget[]; hybrid: boolean; notes: string[] };
  securityRequirements: { controls: string[]; alreadyRequired: string[]; notes: string[] };
  assumptions: Array<{ statement: string; evidenceType: EvidenceType }>;
}

export interface WorkloadProfile {
  id: string;
  version: number;
  submitted: CreateWorkloadProfileInput;
  inputs: Record<string, ResolvedValue>;
  result: WorkloadProfileResult;
  rulesVersion: string;
  createdAt: string;
}

export interface WorkloadProfileDefaults {
  inputs: Record<string, ResolvedValue>;
  preview: WorkloadProfileResult;
}
