import { apiClient } from './client';
import { armHeaders } from './azureAuth';

// Azure AI Factory Builder - mirrors backend/src/azure-builder (Wave 1: Phases 0 Connect and 1 Discover; Wave 2: Phase 2 Use case intake; Wave 3: Phase 3 Architect; Wave 4: Phase 4 Generate IaC; Wave 5: Phase 5 Validate & approve; Wave 6a: live Connect and Discover).

export type DeploymentModel = 'centralised' | 'hub_and_spoke' | 'federated';
export type AzureRole = 'owner' | 'contributor' | 'reader' | 'unknown';
export type ResourceGroupMode = 'existing' | 'new';
export type ProfileSource = 'form' | 'resource_graph' | 'sample' | 'live';

export interface PermissionLevel {
  role: AzureRole;
  canDesign: boolean;
  canDeploy: boolean;
  /** Live only: whether the user may create role assignments (the bundle's managed-identity grants need it). */
  canAssignRoles?: boolean | null;
  verified: boolean;
  note: string;
}

export interface AzureConnectionInput {
  tenantId: string;
  subscriptionId: string;
  subscriptionName?: string;
  resourceGroup: string;
  resourceGroupMode: ResourceGroupMode;
  region: string;
  deploymentModel: DeploymentModel;
  role: AzureRole;
}

export interface AzureConnection extends AzureConnectionInput {
  id: string;
  version: number;
  active: boolean;
  source: 'declared' | 'live';
  /** Live only: what Azure reported on the target scope, and the Azure account that verified it. */
  permissions?: { scope: string; canRead: boolean; canWrite: boolean; canAssignRoles: boolean } | null;
  azureUser?: string | null;
  createdAt: string;
  permission?: PermissionLevel;
}

export interface ModelQuota { region: string; model: string; sku: string; limitTpm: number; usedTpm: number }

export interface EnvironmentProfile {
  subscriptionId: string;
  scannedAt: string;
  network: { vnets: Array<{ id: string; name: string; location: string; addressPrefixes: string[] }>; hubVnetId: string | null; privateDnsZones: string[] };
  monitoring: { workspaces: Array<{ id: string; name: string; location: string }>; logAnalyticsId: string | null };
  security: { keyVaults: string[]; secureScore: number | null };
  ai: { existingAccounts: Array<{ id: string; name: string; location: string; kind: string; sku: string; publicNetworkAccess: string | null }>; modelQuota: ModelQuota[] };
  policy: { allowedLocations: string[]; requiredTags: string[]; denyPublicNetworkAccess: boolean; deniedSkus: string[] };
  resourceCount: number;
}

export interface EnvironmentConstraints {
  targetRegion: string | null;
  targetRegionAllowed: boolean | null;
  allowedRegions: string[];
  privateEndpointsRequired: boolean;
  requiredTags: string[];
  reuse: Array<{ component: string; resourceId: string; reason: string }>;
  missingPrivateDnsZones: string[];
  modelQuota: Array<ModelQuota & { headroomTpm: number; headroomPercent: number }>;
  warnings: string[];
}

export interface AzureEnvironmentProfile {
  id: string;
  version: number;
  connectionVersion: number;
  source: ProfileSource;
  profile: EnvironmentProfile;
  constraints: EnvironmentConstraints;
  problems: string[];
  createdAt: string;
}

// Wave 2: Phase 2 Use case intake (backend use-case-spec.ts).
export type SolutionPattern = 'rag-assistant' | 'agentic-workflow' | 'document-intelligence' | 'conversational-copilot' | 'predictive-ml';
export type RiskClass = 'low' | 'medium' | 'high';
export type UserType = 'internal' | 'external' | 'mixed';
export type Channel = 'web' | 'teams' | 'mobile' | 'api' | 'email';
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';
export type DataRefresh = 'static' | 'weekly' | 'daily' | 'hourly' | 'realtime';
export type TargetEnvironment = 'dev' | 'test' | 'prod';

export interface PatternInfo { id: SolutionPattern; label: string; typical: string; mvp: boolean }

export interface DataSourceSpec {
  source: string;
  format: string;
  volumeGb: number;
  classification: DataClassification;
  containsPersonalData: boolean;
  refresh: DataRefresh;
}

export interface IntakeAnswers {
  name: string;
  business: { problem: string; kpis: string[]; sponsor: string; costCenter: string };
  users: { type: UserType; count: number; peakConcurrent: number; channels: Channel[] };
  data: DataSourceSpec[];
  constraints: { regions: string[]; dataResidency: string | null; compliance: string[]; latencyMs: number | null; availability: string | null; monthlyBudgetUsd: number | null };
  environment: TargetEnvironment;
}

export interface ClassificationDetail {
  pattern: SolutionPattern;
  confidence: number;
  rationale: string;
  missingInfo: string[];
  riskClass: RiskClass;
  classifier: string;
  scores: Record<SolutionPattern, number>;
  signals: Record<SolutionPattern, string[]>;
  riskReasons: string[];
}

export interface PatternChoice {
  id: SolutionPattern;
  confidence: number;
  rationale: string;
  overriddenBy: string | null;
  overrideReason: string | null;
  classifiedAs: SolutionPattern;
  missingInfo: string[];
  riskClass: RiskClass;
  supportedInMvp: boolean;
}

export interface UseCaseSpec extends IntakeAnswers { pattern: PatternChoice; owner: string }

export interface AzureUseCase {
  id: string;
  version: number;
  spec: UseCaseSpec;
  classification: ClassificationDetail;
  createdAt: string;
}

export interface IntakePrefill { answers: IntakeAnswers; sources: Record<string, string>; patterns: PatternInfo[] }

// Wave 3: Phase 3 Architect (backend architecture.ts).
export type Zone = 'edge' | 'app' | 'ai' | 'data' | 'network' | 'monitoring';
export type ConnectionKind = 'https' | 'private-endpoint' | 'shared-private-link' | 'identity' | 'indexer' | 'hosted-in' | 'telemetry' | 'diagnostics' | 'workspace' | 'subnet' | 'dns-zone' | 'peering';

export interface ArchitectureOptions { apiGateway: boolean | null; chatHistory: boolean; deployment: 'auto' | 'payg' | 'ptu' }

export interface ArchitectureComponent {
  id: string;
  type: string;
  label: string;
  module: string;
  zone: Zone;
  params: Record<string, unknown>;
  reuseExisting: boolean;
  resourceId: string | null;
  optional: boolean;
  reason: string;
}

export interface Adr { id: string; title: string; status: string; context: string; decision: string; consequences: string; choice: string }

export interface CostLineItem { component: string; item: string; quantity: string; monthlyUsd: number; oneTimeUsd: number; basis: string }

export interface ArchitectureSpec {
  useCaseId: string;
  useCaseName: string;
  specVersion: number;
  profileVersion: number;
  pattern: string;
  region: string;
  environment: string;
  private: boolean;
  options: ArchitectureOptions;
  sizing: {
    monthlyRequests: number; peakTpm: number; documentGb: number; corpusTokens: number; chunks: number; vectorGb: number; indexGb: number;
    searchTier: string; searchReplicas: number; searchPartitions: number; deploymentSku: string; deploymentCapacity: number;
  };
  components: ArchitectureComponent[];
  connections: Array<{ from: string; to: string; kind: ConnectionKind }>;
  decisions: Array<{ adr: string; choice: string; reason: string }>;
  adrs: Adr[];
  tags: Record<string, string | null>;
  cost: {
    currency: string; monthlyUsd: number; oneTimeUsd: number; lineItems: CostLineItem[]; assumptions: string[];
    rateCard: { version: string; lastReviewed: string; source: string }; budgetUsd: number | null; overBudget: boolean;
    modelOptions: { paygMonthlyUsd: number; ptuMonthlyUsd: number; ptuUnits: number };
  };
  summary: string;
  warnings: string[];
  generator: { rules: string; explainer: string };
}

export interface AzureArchitecture {
  id: string;
  version: number;
  useCaseVersion: number;
  profileVersion: number;
  spec: ArchitectureSpec;
  createdAt: string;
}

// Wave 4: Phase 4 Generate IaC (backend iac-bundle.ts, iac-validate.ts).
export interface IacFile { path: string; content: string }
export interface RequiredInput { name: string; where: string; description: string; when: 'before-deploy' | 'after-deploy' }
export interface IacDiagnostic { file: string; line: number; column: number; level: 'error' | 'warning' | 'info'; code: string; message: string }
export interface IacValidation {
  status: 'passed' | 'failed' | 'skipped';
  tool: string | null;
  checkedAt: string;
  commands: string[];
  diagnostics: IacDiagnostic[];
  reason: string | null;
}

export type TargetEnv = 'dev' | 'test' | 'prod';
export const TARGET_ENVS: TargetEnv[] = ['dev', 'test', 'prod'];
export interface EnvInputs { vnetAddressPrefix?: string; privateDnsZoneResourceGroupId?: string; containerImage?: string }
export type InputName = keyof EnvInputs;

export interface AzureIacBundle {
  id: string;
  version: number;
  architectureVersion: number;
  workload: string;
  root: string;
  generator: string;
  files: IacFile[];
  requiredInputs: RequiredInput[];
  notes: string[];
  validation: IacValidation;
  inputs: Partial<Record<TargetEnv, EnvInputs>>;
  missingInputs: Partial<Record<TargetEnv, InputName[]>>;
  createdAt: string;
}

// Wave 5: Phase 5 Validate & approve (backend validate-approve.ts).
export type ChangeType = 'Create' | 'Modify' | 'Delete' | 'NoChange' | 'Ignore' | 'Deploy' | 'Unsupported';
export interface WhatIfChange {
  resourceId: string;
  type: string;
  name: string;
  changeType: ChangeType;
  owned: boolean;
  location: string | null;
  propertyChanges: number;
  note: string | null;
}
export interface ValidationReport {
  environment: TargetEnv;
  iacVersion: number;
  iacHash: string;
  architectureVersion: number;
  useCaseVersion: number;
  source: 'planned' | 'arm';
  compile: { status: string; tool: string | null };
  missingInputs: InputName[];
  counts: Record<ChangeType, number>;
  blocking: string[];
  risks: string[];
  monthlyUsd: number;
  budgetUsd: number | null;
  riskClass: RiskClass;
  raiRequired: boolean;
  approvable: boolean;
}
export interface AzureWhatIf {
  id: string;
  iacVersion: number;
  iacHash: string;
  environment: TargetEnv;
  source: 'planned' | 'arm';
  status: 'succeeded' | 'failed';
  changes: WhatIfChange[];
  report: ValidationReport;
  createdAt: string;
}
export interface AzureApproval {
  id: string;
  approverEmail: string;
  environment: TargetEnv;
  decision: 'approved' | 'rejected';
  comments: string | null;
  iacVersion: number;
  iacHash: string;
  architectureVersion: number;
  useCaseVersion: number;
  whatIfId: string;
  evidence: 'arm-what-if' | 'offline-plan';
  raiChecklist: string[];
  createdAt: string;
}
/** Mirrors RAI_CHECKLIST in backend validate-approve.ts (spec 12: required for a high-risk use case). */
export const RAI_CHECKLIST: Array<{ id: string; text: string }> = [
  { id: 'content-safety', text: 'Content Safety filters are on for every model deployment and their thresholds were reviewed.' },
  { id: 'data-review', text: 'The data sources were reviewed for personal and regulated data, and access follows least privilege.' },
  { id: 'human-oversight', text: 'Answers that affect people (HR, finance, legal decisions) are reviewed by a person; the assistant does not decide.' },
  { id: 'transparency', text: 'Users are told they are using AI and can see the sources behind each answer.' },
  { id: 'evaluation', text: 'Groundedness and safety were evaluated on a test set before release.' },
  { id: 'incident', text: 'There is a way to report harmful answers, and an owner who acts on reports.' },
];

export interface AzureBuilderState {
  connection: (AzureConnection & { permission: PermissionLevel }) | null;
  environmentProfile: AzureEnvironmentProfile | null;
  profileStale: boolean;
  useCase: AzureUseCase | null;
  architecture: AzureArchitecture | null;
  architectureStale: boolean;
  iacBundle: Omit<AzureIacBundle, 'files'> | null;
  iacStale: boolean;
}

export interface ProfileFormInput {
  hubVnetId?: string;
  logAnalyticsId?: string;
  privateDnsZones?: string[];
  keyVaults?: string[];
  secureScore?: number;
  allowedLocations?: string[];
  requiredTags?: string[];
  denyPublicNetworkAccess?: boolean;
  deniedSkus?: string[];
  modelQuota?: Array<Partial<ModelQuota>>;
}

export interface DiscoveryQuery { id: string; title: string; query: string }

export interface LiveSubscription { subscriptionId: string; displayName: string; tenantId: string; state: string }

/** Phase 0 live: the tenant, subscription name and role come from Azure. */
export interface LiveConnectionInput {
  subscriptionId: string;
  resourceGroup: string;
  resourceGroupMode: ResourceGroupMode;
  region: string;
  deploymentModel: DeploymentModel;
}

const base = (projectId: string) => `/projects/${projectId}/azure-builder`;

export const azureBuilderApi = {
  state: (projectId: string) => apiClient.get<AzureBuilderState>(base(projectId)).then((r) => r.data),
  connect: (projectId: string, input: AzureConnectionInput) => apiClient.post<AzureConnection>(`${base(projectId)}/connections`, input).then((r) => r.data),
  disconnect: (projectId: string) => apiClient.post(`${base(projectId)}/connections/disconnect`).then((r) => r.data),
  connections: (projectId: string) => apiClient.get<AzureConnection[]>(`${base(projectId)}/connections`).then((r) => r.data),
  discover: async (projectId: string, body: { source: ProfileSource; resourceGraph?: string; form?: ProfileFormInput }) =>
    apiClient.post<AzureEnvironmentProfile>(`${base(projectId)}/environment-profiles`, body, body.source === 'live' ? { headers: await armHeaders() } : undefined).then((r) => r.data),
  // Live Azure (Wave 6) - each call carries the user's ARM token in a header, never in the body.
  liveSubscriptions: async (projectId: string) => apiClient.get<LiveSubscription[]>(`${base(projectId)}/live/subscriptions`, { headers: await armHeaders() }).then((r) => r.data),
  liveResourceGroups: async (projectId: string, subscriptionId: string) =>
    apiClient.get<Array<{ name: string; location: string }>>(`${base(projectId)}/live/subscriptions/${subscriptionId}/resource-groups`, { headers: await armHeaders() }).then((r) => r.data),
  connectLive: async (projectId: string, input: LiveConnectionInput) =>
    apiClient.post<AzureConnection & { permission: PermissionLevel }>(`${base(projectId)}/connections/live`, input, { headers: await armHeaders() }).then((r) => r.data),
  profiles: (projectId: string) => apiClient.get<AzureEnvironmentProfile[]>(`${base(projectId)}/environment-profiles`).then((r) => r.data),
  queries: (projectId: string) => apiClient.get<DiscoveryQuery[]>(`${base(projectId)}/discovery-queries`).then((r) => r.data),
  intakePrefill: (projectId: string) => apiClient.get<IntakePrefill>(`${base(projectId)}/use-cases/prefill`).then((r) => r.data),
  submitUseCase: (projectId: string, answers: IntakeAnswers) => apiClient.post<AzureUseCase>(`${base(projectId)}/use-cases`, answers).then((r) => r.data),
  overridePattern: (projectId: string, body: { pattern: SolutionPattern; reason: string }) =>
    apiClient.post<AzureUseCase>(`${base(projectId)}/use-cases/override`, body).then((r) => r.data),
  useCases: (projectId: string) => apiClient.get<AzureUseCase[]>(`${base(projectId)}/use-cases`).then((r) => r.data),
  generateArchitecture: (projectId: string, options: Partial<ArchitectureOptions>) =>
    apiClient.post<AzureArchitecture>(`${base(projectId)}/architectures`, options).then((r) => r.data),
  architectures: (projectId: string) => apiClient.get<AzureArchitecture[]>(`${base(projectId)}/architectures`).then((r) => r.data),
  generateIac: (projectId: string, body: { workload?: string; inputs?: Partial<Record<TargetEnv, EnvInputs>> }) => apiClient.post<AzureIacBundle>(`${base(projectId)}/iac`, body).then((r) => r.data),
  iacBundles: (projectId: string) => apiClient.get<AzureIacBundle[]>(`${base(projectId)}/iac`).then((r) => r.data),
  runWhatIf: (projectId: string, body: { environment: TargetEnv; source: 'planned' | 'arm'; result?: string }) =>
    apiClient.post<AzureWhatIf>(`${base(projectId)}/what-ifs`, body).then((r) => r.data),
  whatIfs: (projectId: string) => apiClient.get<AzureWhatIf[]>(`${base(projectId)}/what-ifs`).then((r) => r.data),
  decide: (projectId: string, body: { environment: TargetEnv; decision: 'approved' | 'rejected'; comments?: string; raiChecklist?: string[] }) =>
    apiClient.post<AzureApproval>(`${base(projectId)}/approvals`, body).then((r) => r.data),
  approvals: (projectId: string) => apiClient.get<AzureApproval[]>(`${base(projectId)}/approvals`).then((r) => r.data),
  downloadIac: (projectId: string, version: number) => apiClient.get<Blob>(`${base(projectId)}/iac/${version}/download`, { responseType: 'blob' }).then((r) => r.data),
};

export const REGIONS: Array<{ value: string; label: string }> = [
  { value: 'centralindia', label: 'Central India' },
  { value: 'southindia', label: 'South India' },
  { value: 'westindia', label: 'West India' },
  { value: 'eastus', label: 'East US' },
  { value: 'eastus2', label: 'East US 2' },
  { value: 'westus3', label: 'West US 3' },
  { value: 'westeurope', label: 'West Europe' },
  { value: 'northeurope', label: 'North Europe' },
  { value: 'swedencentral', label: 'Sweden Central' },
  { value: 'uksouth', label: 'UK South' },
  { value: 'southeastasia', label: 'Southeast Asia' },
  { value: 'australiaeast', label: 'Australia East' },
  { value: 'japaneast', label: 'Japan East' },
];
