import { apiClient } from './client';

// Azure AI Factory Builder - mirrors backend/src/azure-builder (Wave 1: Phases 0 Connect and 1 Discover).

export type DeploymentModel = 'centralised' | 'hub_and_spoke' | 'federated';
export type AzureRole = 'owner' | 'contributor' | 'reader' | 'unknown';
export type ResourceGroupMode = 'existing' | 'new';
export type ProfileSource = 'form' | 'resource_graph' | 'sample';

export interface PermissionLevel {
  role: AzureRole;
  canDesign: boolean;
  canDeploy: boolean;
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

export interface AzureBuilderState {
  connection: (AzureConnection & { permission: PermissionLevel }) | null;
  environmentProfile: AzureEnvironmentProfile | null;
  profileStale: boolean;
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

const base = (projectId: string) => `/projects/${projectId}/azure-builder`;

export const azureBuilderApi = {
  state: (projectId: string) => apiClient.get<AzureBuilderState>(base(projectId)).then((r) => r.data),
  connect: (projectId: string, input: AzureConnectionInput) => apiClient.post<AzureConnection>(`${base(projectId)}/connections`, input).then((r) => r.data),
  disconnect: (projectId: string) => apiClient.post(`${base(projectId)}/connections/disconnect`).then((r) => r.data),
  connections: (projectId: string) => apiClient.get<AzureConnection[]>(`${base(projectId)}/connections`).then((r) => r.data),
  discover: (projectId: string, body: { source: ProfileSource; resourceGraph?: string; form?: ProfileFormInput }) =>
    apiClient.post<AzureEnvironmentProfile>(`${base(projectId)}/environment-profiles`, body).then((r) => r.data),
  profiles: (projectId: string) => apiClient.get<AzureEnvironmentProfile[]>(`${base(projectId)}/environment-profiles`).then((r) => r.data),
  queries: (projectId: string) => apiClient.get<DiscoveryQuery[]>(`${base(projectId)}/discovery-queries`).then((r) => r.data),
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
