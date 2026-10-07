import { ProfileFormInput } from './environment-profile';

/**
 * Azure Resource Graph queries for Phase 1 (spec 9.3). Offline mode: the user
 * runs the combined query in the portal's Resource Graph Explorer (or with
 * `az graph query -q "<query>" --first 1000 -o json`) and pastes the result;
 * the live wave runs the same queries itself. Read-only - Reader access is enough.
 */
export const DISCOVERY_QUERIES = [
  {
    id: 'combined',
    title: 'Everything Discover reads (run this one)',
    query:
      "Resources\n" +
      "| where type in~ ('microsoft.network/virtualnetworks', 'microsoft.network/privatednszones', 'microsoft.cognitiveservices/accounts',\n" +
      "                   'microsoft.operationalinsights/workspaces', 'microsoft.keyvault/vaults')\n" +
      "| project id, name, type, location, kind, sku,\n" +
      "          addressSpace = properties.addressSpace.addressPrefixes,\n" +
      "          publicAccess = properties.publicNetworkAccess",
  },
  { id: 'vnets', title: 'Virtual networks and address spaces', query: "Resources | where type =~ 'microsoft.network/virtualnetworks'\n| project id, name, type, location, addressSpace = properties.addressSpace.addressPrefixes" },
  { id: 'dns', title: 'Private DNS zones', query: "Resources | where type =~ 'microsoft.network/privatednszones' | project id, name, type" },
  { id: 'ai', title: 'Existing AI / Azure OpenAI accounts', query: "Resources | where type =~ 'microsoft.cognitiveservices/accounts'\n| project id, name, type, location, kind, sku = sku.name, publicAccess = properties.publicNetworkAccess" },
  { id: 'logs', title: 'Log Analytics workspaces', query: "Resources | where type =~ 'microsoft.operationalinsights/workspaces' | project id, name, type, location" },
  {
    id: 'policy',
    title: 'Policy assignments (read the effects into the Policy fields by hand)',
    query: "PolicyResources | where type =~ 'microsoft.authorization/policyassignments'\n| project name, displayName = properties.displayName, scope = properties.scope, parameters = properties.parameters",
  },
];

const SUB = '00000000-0000-4000-8000-000000000001';
const rg = (group: string, provider: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${group}/providers/${provider}/${name}`;

/** A realistic hub-and-spoke landing zone in Central India, for trying Discover without Azure access. */
export const SAMPLE_SUBSCRIPTION_ID = SUB;

export const SAMPLE_RESOURCE_GRAPH_ROWS: Array<Record<string, unknown>> = [
  { id: rg('rg-hub-network', 'Microsoft.Network/virtualNetworks', 'vnet-hub-prod-cin-001'), name: 'vnet-hub-prod-cin-001', type: 'microsoft.network/virtualnetworks', location: 'centralindia', addressSpace: ['10.0.0.0/16'] },
  { id: rg('rg-spoke-apps', 'Microsoft.Network/virtualNetworks', 'vnet-spoke-apps-cin-001'), name: 'vnet-spoke-apps-cin-001', type: 'microsoft.network/virtualnetworks', location: 'centralindia', addressSpace: ['10.1.0.0/16'] },
  { id: rg('rg-hub-dns', 'Microsoft.Network/privateDnsZones', 'privatelink.openai.azure.com'), name: 'privatelink.openai.azure.com', type: 'microsoft.network/privatednszones', location: 'global' },
  { id: rg('rg-hub-dns', 'Microsoft.Network/privateDnsZones', 'privatelink.blob.core.windows.net'), name: 'privatelink.blob.core.windows.net', type: 'microsoft.network/privatednszones', location: 'global' },
  { id: rg('rg-hub-dns', 'Microsoft.Network/privateDnsZones', 'privatelink.vaultcore.azure.net'), name: 'privatelink.vaultcore.azure.net', type: 'microsoft.network/privatednszones', location: 'global' },
  { id: rg('rg-hub-monitor', 'Microsoft.OperationalInsights/workspaces', 'log-platform-prod-cin-001'), name: 'log-platform-prod-cin-001', type: 'microsoft.operationalinsights/workspaces', location: 'centralindia' },
  { id: rg('rg-hub-security', 'Microsoft.KeyVault/vaults', 'kv-platform-prod-cin-01'), name: 'kv-platform-prod-cin-01', type: 'microsoft.keyvault/vaults', location: 'centralindia' },
  { id: rg('rg-ai-shared', 'Microsoft.CognitiveServices/accounts', 'aoai-shared-prod-cin-001'), name: 'aoai-shared-prod-cin-001', type: 'microsoft.cognitiveservices/accounts', location: 'centralindia', kind: 'OpenAI', sku: 'S0', publicAccess: 'Disabled' },
];

export const SAMPLE_FORM_INPUT: ProfileFormInput = {
  secureScore: 72,
  allowedLocations: ['centralindia', 'southindia'],
  requiredTags: ['costCenter', 'owner'],
  denyPublicNetworkAccess: true,
  deniedSkus: [],
  modelQuota: [
    { region: 'centralindia', model: 'gpt-4o', sku: 'Standard', limitTpm: 150000, usedTpm: 20000 },
    { region: 'centralindia', model: 'text-embedding-3-large', sku: 'Standard', limitTpm: 350000, usedTpm: 40000 },
    { region: 'southindia', model: 'gpt-4o', sku: 'Standard', limitTpm: 100000, usedTpm: 90000 },
  ],
};
