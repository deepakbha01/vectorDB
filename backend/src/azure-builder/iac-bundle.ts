/**
 * Azure AI Factory Builder - Phase 4 (Generate IaC) core.
 *
 * Composes a repo-ready bundle (spec 11.2) from an ArchitectureSpec: Bicep
 * that references Azure Verified Modules pinned to explicit versions, one
 * .bicepparam per environment, a GitHub Actions pipeline (OIDC, what-if,
 * deploy), docs/architecture.md and a README. Deterministic code, never an
 * LLM (spec golden rule). Pure - no I/O.
 *
 * Rules (spec 11.1): CAF names, mandatory tags on every resource, managed
 * identity and RBAC instead of keys, public access disabled when the design is
 * private, diagnostics to Log Analytics, nothing environment-specific in
 * main.bicep.
 */
import { ArchitectureComponent, ArchitectureSpec, AzureCatalog, ZONES } from './architecture';

export type TargetEnv = 'dev' | 'test' | 'prod';
export const TARGET_ENVS: TargetEnv[] = ['dev', 'test', 'prod'];

export interface IacCatalog {
  avm: Record<string, string>;
  botServiceApiVersion: string;
  modelVersions: Record<string, string>;
  raiPolicyName: string;
  placeholderImage: string;
  placeholderPort: number;
  regionAbbreviations: Record<string, string>;
  roles: Record<string, string>;
}

export interface IacFile { path: string; content: string }

/** Something the generator cannot know and will not invent (spec: never guess). */
export interface RequiredInput { name: string; where: string; description: string; when: 'before-deploy' | 'after-deploy' }

export interface IacBundle {
  root: string;
  workload: string;
  files: IacFile[];
  requiredInputs: RequiredInput[];
  notes: string[];
  generator: string;
}

export interface IacInput {
  /** The approved design (its environment's sizing is used for that environment's parameters). */
  spec: ArchitectureSpec;
  /** The same design re-run for each environment, for that environment's sizing. */
  specsByEnv: Record<TargetEnv, ArchitectureSpec>;
  architectureVersion: number;
  workload: string;
  catalog: AzureCatalog & { iac: IacCatalog };
}

export const IAC_GENERATOR_ID = 'bicep-avm-v1';
const WORKLOAD_RE = /^[a-z][a-z0-9]{1,11}$/;

/** A Bicep single-quoted string literal; user text can neither close the string nor start an interpolation. */
export function bicepString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$\{/g, '\\${').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`;
}

/** A Bicep literal for plain data (strings, numbers, booleans, arrays, objects). */
export function bicepValue(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return bicepString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${inner}${bicepValue(x, inner)}`).join('\n')}\n${indent}]` : '[]';
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  const key = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : bicepString(k));
  return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${bicepValue(x, inner)}`).join('\n')}\n${indent}}`;
}

/** Default workload name for CAF resource names: lower-case letters and digits, at most 12. */
export function deriveWorkload(name: string): string {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let w = words.join('');
  if (w.length > 12) w = words.length >= 3 ? words.map((x) => x.slice(0, 4)).join('').slice(0, 12) : w.slice(0, 12);
  if (!/^[a-z]/.test(w)) w = `uc${w}`.slice(0, 12);
  return words.length && WORKLOAD_RE.test(w) ? w : 'workload';
}

export function isValidWorkload(w: string): boolean {
  return WORKLOAD_RE.test(w);
}

/** Folder-safe name, at most 40 characters, cut at a word boundary. */
const kebab = (s: string) => {
  const k = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = k.length > 40 ? k.slice(0, 41).replace(/-[^-]*$/, '') : k;
  return cut || 'use-case';
};

/**
 * Tagged template for Bicep and YAML text: `#{` in the static parts becomes
 * `${` (so the TypeScript source can hold Bicep interpolation), while inserted
 * values are kept exactly as given.
 */
function tpl(s: TemplateStringsArray, ...v: unknown[]): string {
  return s.reduce((out, part, i) => out + part.replace(/#\{/g, '${') + (i < v.length ? String(v[i]) : ''), '');
}

/** Drops the blank lines left by omitted optional blocks, keeping single blank separators. */
const tidy = (s: string) => `${s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;

/** A private DNS zone name as a Bicep expression; storage zones use environment() so the template works in every cloud. */
function zoneName(zone: string): string {
  const storage = zone.match(/^(.*)\.core\.windows\.net$/);
  // az.environment(): the `environment` parameter shadows the bare function name.
  return storage ? "'" + storage[1] + ".${az.environment().suffixes.storage}'" : bicepString(zone);
}

const PE_SERVICE: Record<string, string> = { aoai: 'account', search: 'searchService', storage: 'blob', keyvault: 'vault', cosmos: 'Sql' };

export function generateIacBundle(input: IacInput): IacBundle {
  const { spec, catalog } = input;
  const iac = catalog.iac;
  if (!isValidWorkload(input.workload)) throw new Error(`Workload "${input.workload}" must be 2-12 lower-case letters and digits, starting with a letter.`);
  const comp = (id: string) => spec.components.find((c) => c.id === id) ?? null;
  const has = (id: string) => !!comp(id);
  const avm = (module: string) => {
    const version = iac.avm[module];
    if (!version) throw new Error(`No pinned version for ${module} in the catalog.`);
    return `br/public:${module}:${version}`;
  };
  const ref = (id: string) => avm(comp(id)!.module);

  const isPrivate = spec.private;
  const hub = comp('hub-vnet');
  const la = comp('log-analytics')!;
  const laReused = la.reuseExisting;
  const dns = (comp('private-dns')?.params ?? { reuse: [], create: [] }) as { reuse: string[]; create: string[] };
  const peTargets = ((comp('private-endpoints')?.params.targets as string[] | undefined) ?? []).filter((t) => has(t));
  const appInternal = comp('cae')!.params.internal === true;
  const ingressExternal = comp('app')!.params.ingress !== 'internal';
  const roles = iac.roles;
  const chatModel = catalog.models.chat;
  const embModel = catalog.models.embedding;
  const regionAbbr = iac.regionAbbreviations[spec.region] ?? spec.region.slice(0, 4);
  const notes: string[] = [];
  const requiredInputs: RequiredInput[] = [];

  // ---------------------------------------------------------------- main.bicep
  // Created zones live in this resource group; reused ones in privateDnsZoneResourceGroupId (zoneName() is a quoted literal).
  const zoneId = (zone: string) =>
    dns.create.includes(zone)
      ? `resourceId('Microsoft.Network/privateDnsZones', ${zoneName(zone)})`
      : "'${privateDnsZoneResourceGroupId}/providers/Microsoft.Network/privateDnsZones/" + zoneName(zone).slice(1);
  const roleAssignment = (role: string, comment: string) => tpl`
      {
        // ${comment}
        principalId: identity.outputs.principalId
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: ${bicepString(roles[role])}
      }`;
  const privateEndpoint = (target: string) => {
    if (!isPrivate || !peTargets.includes(target)) return '';
    const zones = catalog.privateDnsZones[target] ?? [];
    return tpl`
    privateEndpoints: [
      {
        service: '${PE_SERVICE[target]}'
        subnetResourceId: privateEndpointSubnetId
        privateDnsZoneGroup: {
          privateDnsZoneGroupConfigs: [
${zones.map((z) => `            { privateDnsZoneResourceId: ${zoneId(z)} }`).join('\n')}
          ]
        }
        tags: tags
      }
    ]`;
  };
  const dnsDependsOn = isPrivate && dns.create.length ? '\n  dependsOn: [privateDnsZones]' : '';
  const publicAccess = isPrivate ? "'Disabled'" : "'Enabled'";
  const denyAcls = (bypass = "'AzureServices'") => (isPrivate ? `\n    networkAcls: {\n      defaultAction: 'Deny'\n      bypass: ${bypass}\n    }` : '');
  const diag = '\n    diagnosticSettings: diagnostics';

  const params: string[] = [];
  const param = (decorators: string[], decl: string) => params.push([...decorators, decl].join('\n'));
  param(["@description('Short workload name used in every resource name (CAF: <type>-<workload>-<env>-<region>-<instance>).')", '@minLength(2)', '@maxLength(12)'], 'param workload string');
  param(["@description('Target environment.')", "@allowed(['dev', 'test', 'prod'])"], 'param environment string');
  param(["@description('Region for every resource. Must be allowed by policy.')"], 'param location string = resourceGroup().location');
  param(["@description('Region abbreviation used in resource names.')", '@maxLength(4)'], 'param regionAbbreviation string');
  param(["@description('Instance number used in resource names.')"], "param instance string = '001'");
  param(["@description('Tags on every resource: useCaseId, owner, costCenter, environment, createdBy, plus any tag the policy requires.')"], 'param tags object');
  param(["@description('Chat model deployment type.')", "@allowed(['GlobalStandard', 'DataZoneStandard', 'Standard', 'ProvisionedManaged'])"], 'param chatModelSku string');
  param(["@description('Chat model capacity: thousands of tokens per minute, or PTUs for ProvisionedManaged.')", '@minValue(1)'], 'param chatModelCapacity int');
  param(["@description('Embedding model deployment type.')", "@allowed(['GlobalStandard', 'DataZoneStandard', 'Standard'])"], 'param embeddingModelSku string');
  param(["@description('Embedding model capacity in thousands of tokens per minute.')", '@minValue(1)'], 'param embeddingModelCapacity int');
  param(["@description('Azure AI Search tier.')", "@allowed(['basic', 'standard', 'standard2'])"], 'param searchSku string');
  param(['@minValue(1)', '@maxValue(12)'], 'param searchReplicaCount int');
  param(['@minValue(1)', '@maxValue(12)'], 'param searchPartitionCount int');
  param(["@allowed(['Standard_LRS', 'Standard_ZRS'])"], 'param storageSkuName string');
  param(["@description('Replicas kept warm for the assistant API.')", '@minValue(0)'], 'param apiMinReplicas int');
  param(['@minValue(1)'], 'param apiMaxReplicas int');
  param(["@description('Key Vault purge protection (cannot be turned off once on).')"], 'param keyVaultPurgeProtection bool');
  param(["@description('Container image of the assistant API. The default is a placeholder that answers HTTP 200.')"], `param containerImage string = ${bicepString(iac.placeholderImage)}`);
  param(["@description('Port the assistant API listens on.')"], `param containerPort int = ${iac.placeholderPort}`);
  if (!laReused) param(['@minValue(30)', '@maxValue(730)'], 'param logRetentionInDays int');
  else param(["@description('Existing Log Analytics workspace found by Discover (reused).')"], 'param logAnalyticsWorkspaceResourceId string');
  if (isPrivate) {
    param(["@description('Address range for the use-case spoke VNet, from the network team (a /22).')"], 'param vnetAddressPrefix string');
    if (dns.reuse.length) param(["@description('Resource group that holds the shared private DNS zones (e.g. the hub DNS resource group).')"], 'param privateDnsZoneResourceGroupId string');
    if (hub) param(["@description('Existing hub VNet the spoke is peered to.')"], 'param hubVnetResourceId string');
  }
  if (has('apim')) {
    param(["@allowed(['Developer', 'StandardV2'])"], 'param apimSku string');
    param(["@description('API Management publisher e-mail (receives service notifications).')"], 'param apimPublisherEmail string');
    param([], 'param apimPublisherName string');
  }
  if (has('bot')) param(["@allowed(['F0', 'S1'])"], 'param botSku string');

  const names: Record<string, string> = {
    identity: "'id-${nameSuffix}'",
    openAi: "'oai-${nameSuffix}-${unique}'",
    search: "'srch-${nameSuffix}-${unique}'",
    storage: "take(toLower('st${workload}${environment}${regionAbbreviation}${unique}'), 24)",
    keyVault: "take('kv-${workload}-${environment}-${unique}', 24)",
    containerEnv: "'cae-${nameSuffix}'",
    containerApp: "take('ca-${nameSuffix}', 32)",
    appInsights: "'appi-${nameSuffix}'",
  };
  if (!laReused) names.logAnalytics = "'log-${nameSuffix}'";
  if (isPrivate) names.vnet = "'vnet-${nameSuffix}'";
  if (has('cosmos')) names.cosmos = "'cosmos-${nameSuffix}-${unique}'";
  if (has('apim')) names.apim = "'apim-${nameSuffix}-${unique}'";
  if (has('bot')) names.bot = "'bot-${nameSuffix}'";

  const sections: string[] = [];
  const section = (title: string, body: string) => sections.push(`// ---- ${title} ----\n${body.trim()}`);

  section('Identity (RBAC for every service; no keys)', tpl`
module identity '${ref('identity')}' = {
  name: take('#{deployment().name}-identity', 64)
  params: {
    name: names.identity
    location: location
    tags: tags
  }
}`);

  section(laReused ? 'Monitoring (existing Log Analytics workspace is reused)' : 'Monitoring', tpl`
${laReused ? '' : tpl`module logAnalytics '${ref('log-analytics')}' = {
  name: take('#{deployment().name}-log', 64)
  params: {
    name: names.logAnalytics
    location: location
    tags: tags
    skuName: 'PerGB2018'
    dataRetention: logRetentionInDays
  }
}
`}
var logAnalyticsId = ${laReused ? 'logAnalyticsWorkspaceResourceId' : 'logAnalytics.outputs.resourceId'}
var diagnostics = [
  {
    workspaceResourceId: logAnalyticsId
  }
]

module appInsights '${ref('app-insights')}' = {
  name: take('#{deployment().name}-appi', 64)
  params: {
    name: names.appInsights
    location: location
    tags: tags
    workspaceResourceId: logAnalyticsId
    applicationType: 'web'
    disableLocalAuth: true
    roleAssignments: [${roleAssignment('monitoringMetricsPublisher', 'Send telemetry with Entra ID instead of an instrumentation key')}
    ]
  }
}`);

  if (isPrivate) {
    const subnets = [
      "      {\n        name: 'snet-apps'\n        addressPrefix: cidrSubnet(vnetAddressPrefix, 23, 0)\n        delegation: 'Microsoft.App/environments'\n      }",
      "      {\n        name: 'snet-private-endpoints'\n        addressPrefix: cidrSubnet(vnetAddressPrefix, 27, 16)\n      }",
      ...(has('apim') ? ["      {\n        name: 'snet-apim'\n        addressPrefix: cidrSubnet(vnetAddressPrefix, 27, 17)\n        delegation: 'Microsoft.Web/serverFarms'\n      }"] : []),
    ];
    section(`Network (spoke${hub ? ' peered to the existing hub' : ''}; subnets carved from vnetAddressPrefix)`, tpl`
module vnet '${ref('vnet')}' = {
  name: take('#{deployment().name}-vnet', 64)
  params: {
    name: names.vnet
    location: location
    tags: tags
    addressPrefixes: [
      vnetAddressPrefix
    ]
    subnets: [
${subnets.join('\n')}
    ]${hub ? `
    peerings: [
      {
        // The hub side of the peering is created by the platform team (remotePeeringEnabled: false).
        remoteVirtualNetworkResourceId: hubVnetResourceId
        allowForwardedTraffic: true
        allowVirtualNetworkAccess: true
        useRemoteGateways: false
        remotePeeringEnabled: false
      }
    ]` : ''}
  }
}

var appsSubnetId = vnet.outputs.subnetResourceIds[0]
var privateEndpointSubnetId = vnet.outputs.subnetResourceIds[1]${has('apim') ? '\nvar apimSubnetId = vnet.outputs.subnetResourceIds[2]' : ''}
${dns.create.length ? tpl`
// Private DNS zones the environment does not have yet (${dns.reuse.length} more are reused from privateDnsZoneResourceGroupId).
var createdPrivateDnsZones = [
${dns.create.map((z) => `  ${zoneName(z)}`).join('\n')}
]

module privateDnsZones '${ref('private-dns')}' = [
  for zone in createdPrivateDnsZones: {
    name: take('#{deployment().name}-dns-#{zone}', 64)
    params: {
      name: zone
      location: 'global'
      tags: tags
      virtualNetworkLinks: [
        {
          virtualNetworkResourceId: vnet.outputs.resourceId
          registrationEnabled: false
        }
      ]
    }
  }
]` : ''}`);
  }

  section('Models (Azure OpenAI in a Foundry / AI Services account; Content Safety on every deployment)', tpl`
module openAi '${ref('aoai')}' = {
  name: take('#{deployment().name}-oai', 64)${dnsDependsOn}
  params: {
    name: names.openAi
    location: location
    tags: tags
    kind: 'AIServices'
    sku: 'S0'
    customSubDomainName: names.openAi
    disableLocalAuth: true
    publicNetworkAccess: ${publicAccess}${denyAcls()}
    deployments: [
      {
        name: 'chat'
        model: {
          format: 'OpenAI'
          name: ${bicepString(chatModel)}
          version: ${bicepString(iac.modelVersions[chatModel] ?? '')}
        }
        sku: {
          name: chatModelSku
          capacity: chatModelCapacity
        }
        raiPolicyName: ${bicepString(iac.raiPolicyName)}
      }
      {
        name: 'embedding'
        model: {
          format: 'OpenAI'
          name: ${bicepString(embModel)}
          version: ${bicepString(iac.modelVersions[embModel] ?? '')}
        }
        sku: {
          name: embeddingModelSku
          capacity: embeddingModelCapacity
        }
        raiPolicyName: ${bicepString(iac.raiPolicyName)}
      }
    ]
    roleAssignments: [${roleAssignment('cognitiveServicesOpenAiUser', 'The assistant and the search indexer call the models')}
    ]${diag}${privateEndpoint('aoai')}
  }
}`);

  section('Data and secrets', tpl`
module storage '${ref('storage')}' = {
  name: take('#{deployment().name}-st', 64)${dnsDependsOn}
  params: {
    name: names.storage
    location: location
    tags: tags
    kind: 'StorageV2'
    skuName: storageSkuName
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: ${publicAccess}${denyAcls()}
    blobServices: {
      containers: [
        {
          name: 'documents'
        }
      ]
    }
    roleAssignments: [${roleAssignment('storageBlobDataContributor', 'Upload documents and let the indexer read them')}
    ]${diag}${privateEndpoint('storage')}
  }
}

module search '${ref('search')}' = {
  name: take('#{deployment().name}-srch', 64)${dnsDependsOn}
  params: {
    name: names.search
    location: location
    tags: tags
    sku: searchSku
    replicaCount: searchReplicaCount
    partitionCount: searchPartitionCount
    semanticSearch: searchSku == 'basic' ? 'free' : 'standard'
    disableLocalAuth: true
    publicNetworkAccess: ${publicAccess}
    managedIdentities: {
      // The indexer and the vectorizer use the workload identity
      userAssignedResourceIds: [
        identity.outputs.resourceId
      ]
    }${isPrivate ? tpl`
    sharedPrivateLinkResources: [
      {
        // Approve on the AI Services account after deployment (see README)
        groupId: 'openai_account'
        privateLinkResourceId: openAi.outputs.resourceId
        requestMessage: 'Azure AI Search vectorizer for #{workload}'
      }
      {
        // Approve on the storage account after deployment (see README)
        groupId: 'blob'
        privateLinkResourceId: storage.outputs.resourceId
        requestMessage: 'Azure AI Search indexer for #{workload}'
      }
    ]` : ''}
    roleAssignments: [${roleAssignment('searchIndexDataContributor', 'Query and load the index')}${roleAssignment('searchServiceContributor', 'Create and update the index definition')}
    ]${diag}${privateEndpoint('search')}
  }
}

module keyVault '${ref('keyvault')}' = {
  name: take('#{deployment().name}-kv', 64)${dnsDependsOn}
  params: {
    name: names.keyVault
    location: location
    tags: tags
    sku: 'standard'
    enableRbacAuthorization: true
    enablePurgeProtection: keyVaultPurgeProtection
    publicNetworkAccess: ${publicAccess}${denyAcls()}
    roleAssignments: [${roleAssignment('keyVaultSecretsUser', 'Read secrets the app cannot avoid (e.g. a third-party key)')}
    ]${diag}${privateEndpoint('keyvault')}
  }
}${has('cosmos') ? tpl`

module cosmos '${ref('cosmos')}' = {
  name: take('#{deployment().name}-cosmos', 64)${dnsDependsOn}
  params: {
    name: names.cosmos
    location: location
    tags: tags
    capacityMode: 'Serverless'
    zoneRedundant: false
    disableLocalAuthentication: true
    disableKeyBasedMetadataWriteAccess: true
    networkRestrictions: {
      publicNetworkAccess: ${publicAccess}
      networkAclBypass: 'None'
    }
    sqlDatabases: [
      {
        name: 'assistant'
        containers: [
          {
            name: 'conversations'
            paths: [
              '/userId'
            ]
          }
        ]
      }
    ]
    sqlRoleAssignments: [
      {
        // Built-in Cosmos DB Data Contributor
        principalId: identity.outputs.principalId
        roleDefinitionId: ${bicepString(roles.cosmosDataContributor)}
      }
    ]${diag}${privateEndpoint('cosmos')}
  }
}` : ''}`);

  const env = [
    ['AZURE_CLIENT_ID', 'identity.outputs.clientId'],
    ['AZURE_OPENAI_ENDPOINT', 'openAi.outputs.endpoint'],
    ['AZURE_OPENAI_CHAT_DEPLOYMENT', "'chat'"],
    ['AZURE_OPENAI_EMBEDDING_DEPLOYMENT', "'embedding'"],
    ['AZURE_SEARCH_ENDPOINT', 'search.outputs.endpoint'],
    ['AZURE_STORAGE_BLOB_ENDPOINT', 'storage.outputs.primaryBlobEndpoint'],
    ['AZURE_KEY_VAULT_URI', 'keyVault.outputs.uri'],
    ...(has('cosmos') ? [['AZURE_COSMOS_ENDPOINT', 'cosmos.outputs.endpoint']] : []),
    ['APPLICATIONINSIGHTS_CONNECTION_STRING', 'appInsights.outputs.connectionString'],
    ['APPLICATIONINSIGHTS_AUTHENTICATION_STRING', "'Authorization=AAD;ClientId=${identity.outputs.clientId}'"],
  ];
  section('Application (Container Apps, workload identity)', tpl`
module containerEnv '${ref('cae')}' = {
  name: take('#{deployment().name}-cae', 64)
  params: {
    name: names.containerEnv
    location: location
    tags: tags
    zoneRedundant: false
    internal: ${appInternal}${isPrivate ? '\n    infrastructureSubnetResourceId: appsSubnetId' : ''}
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }${diag}
  }
}

module containerApp '${ref('app')}' = {
  name: take('#{deployment().name}-ca', 64)
  params: {
    name: names.containerApp
    location: location
    tags: tags
    environmentResourceId: containerEnv.outputs.resourceId
    workloadProfileName: 'Consumption'
    managedIdentities: {
      userAssignedResourceIds: [
        identity.outputs.resourceId
      ]
    }
    ingressExternal: ${ingressExternal}
    ingressTargetPort: containerPort
    scaleSettings: {
      minReplicas: apiMinReplicas
      maxReplicas: apiMaxReplicas
    }
    containers: [
      {
        name: 'assistant-api'
        image: containerImage
        resources: {
          cpu: json('1.0')
          memory: '2Gi'
        }
        env: [
${env.map(([n, v]) => `          {\n            name: '${n}'\n            value: ${v}\n          }`).join('\n')}
        ]
      }
    ]
  }
}`);

  if (has('apim')) {
    section('AI gateway (API Management)', tpl`
module apim '${ref('apim')}' = {
  name: take('#{deployment().name}-apim', 64)
  params: {
    name: names.apim
    location: location
    tags: tags
    sku: apimSku
    skuCapacity: 1
    availabilityZones: []
    publisherEmail: apimPublisherEmail
    publisherName: apimPublisherName
    managedIdentities: {
      userAssignedResourceIds: [
        identity.outputs.resourceId
      ]
    }${isPrivate ? `
    // Standard v2 integrates with the spoke for outbound calls; the Developer tier stays outside it.
    virtualNetworkType: apimSku == 'StandardV2' ? 'External' : 'None'
    subnetResourceId: apimSku == 'StandardV2' ? apimSubnetId : null` : ''}${diag}
  }
}`);
  }

  if (has('bot')) {
    section('Microsoft Teams (Azure Bot; no AVM module is published yet, so a thin wrapper over the native resource)', tpl`
module bot 'modules/bot-service.bicep' = {
  name: take('#{deployment().name}-bot', 64)
  params: {
    name: names.bot
    sku: botSku
    tags: tags
    messagingEndpoint: ${has('apim') ? "'https://${names.apim}.azure-api.net/assistant/api/messages'" : "'https://${containerApp.outputs.fqdn}/api/messages'"}
    msaAppId: identity.outputs.clientId
    msaAppTenantId: tenant().tenantId
    msaAppMsiResourceId: identity.outputs.resourceId
  }
}`);
  }

  const outputs = [
    'output resourceNames object = names',
    'output identityClientId string = identity.outputs.clientId',
    'output openAiEndpoint string = openAi.outputs.endpoint',
    'output searchEndpoint string = search.outputs.endpoint',
    'output containerAppFqdn string = containerApp.outputs.fqdn',
  ];

  const mainBicep = tidy(tpl`
// Generated by the Azure AI Factory Builder (${IAC_GENERATOR_ID}) from ArchitectureSpec v${input.architectureVersion}
// for "${spec.useCaseName.replace(/[\r\n]+/g, ' ')}" (use case v${spec.specVersion}). Pattern: RAG knowledge assistant.
// Every module is an Azure Verified Module pinned to an explicit version. Environment-specific
// values live in params/<env>.bicepparam; nothing environment-specific is hard-coded here.
targetScope = 'resourceGroup'

${params.join('\n\n')}

var nameSuffix = '#{workload}-#{environment}-#{regionAbbreviation}-#{instance}'
// Short suffix for names that must be globally unique.
var unique = substring(uniqueString(resourceGroup().id), 0, 4)
var names = {
${Object.entries(names).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
}

${sections.join('\n\n')}

${outputs.join('\n')}
`);

  // --------------------------------------------------------- bot wrapper module
  const botModule = tidy(tpl`
// Azure Bot with the Microsoft Teams channel. A thin wrapper over the native resource,
// because no Azure Verified Module is published for Microsoft.BotService yet.
// Bot Service is a global resource: location is always 'global'.

@description('Bot resource name.')
param name string

@allowed(['F0', 'S1'])
param sku string

param tags object

@description('HTTPS endpoint that receives Teams messages.')
param messagingEndpoint string

@description('Client ID of the user-assigned managed identity the bot runs as.')
param msaAppId string

param msaAppTenantId string

param msaAppMsiResourceId string

resource bot 'Microsoft.BotService/botServices@${iac.botServiceApiVersion}' = {
  name: name
  location: 'global'
  kind: 'azurebot'
  sku: {
    name: sku
  }
  tags: tags
  properties: {
    displayName: name
    endpoint: messagingEndpoint
    msaAppId: msaAppId
    msaAppType: 'UserAssignedMSI'
    msaAppTenantId: msaAppTenantId
    msaAppMSIResourceId: msaAppMsiResourceId
    disableLocalAuth: true
  }
}

resource teams 'Microsoft.BotService/botServices/channels@${iac.botServiceApiVersion}' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: 'global'
  properties: {
    channelName: 'MsTeamsChannel'
    properties: {
      isEnabled: true
    }
  }
}

output resourceId string = bot.id
`);

  // ------------------------------------------------------ params/<env>.bicepparam
  const paramFile = (env: TargetEnv) => {
    const s = input.specsByEnv[env];
    const c = (id: string) => s.components.find((x) => x.id === id)!;
    const deployments = c('aoai').params.deployments as Array<{ sku: string; capacity: number }>;
    const search = c('search').params as { sku: string; replicaCount: number; partitionCount: number };
    const app = c('app').params as { minReplicas: number };
    const lines: string[] = [
      `// ${env} - generated from ArchitectureSpec v${input.architectureVersion} with ${env} sizing.`,
      "using '../main.bicep'",
      '',
      `param workload = ${bicepString(input.workload)}`,
      `param environment = '${env}'`,
      `param location = ${bicepString(spec.region)}`,
      `param regionAbbreviation = ${bicepString(regionAbbr)}`,
      `param tags = ${bicepValue({ ...spec.tags, environment: env })}`,
      `param chatModelSku = '${deployments[0].sku}'`,
      `param chatModelCapacity = ${deployments[0].capacity}`,
      `param embeddingModelSku = '${deployments[1].sku}'`,
      `param embeddingModelCapacity = ${deployments[1].capacity}`,
      `param searchSku = '${search.sku}'`,
      `param searchReplicaCount = ${search.replicaCount}`,
      `param searchPartitionCount = ${search.partitionCount}`,
      `param storageSkuName = '${c('storage').params.skuName}'`,
      `param apiMinReplicas = ${app.minReplicas}`,
      `param apiMaxReplicas = ${Math.max(3, app.minReplicas * 3)}`,
      `param keyVaultPurgeProtection = ${c('keyvault').params.enablePurgeProtection === true}`,
      `// Replace with the assistant API image once it is published (see README).`,
      `param containerImage = ${bicepString(iac.placeholderImage)}`,
    ];
    if (!laReused) lines.push(`param logRetentionInDays = ${Number(c('log-analytics').params.retentionInDays) || 30}`);
    else lines.push(`param logAnalyticsWorkspaceResourceId = ${bicepString(la.resourceId ?? '')}`);
    if (isPrivate) {
      lines.push("// REQUIRED before deploying: a /22 for this environment's spoke from the network team, e.g. '10.20.0.0/22'.", "param vnetAddressPrefix = ''");
      if (dns.reuse.length) lines.push(`// REQUIRED before deploying: the resource group that holds ${dns.reuse.join(', ')}.`, "param privateDnsZoneResourceGroupId = ''");
      if (hub) lines.push(`param hubVnetResourceId = ${bicepString(hub.resourceId ?? '')}`);
    }
    if (has('apim')) {
      lines.push(`param apimSku = '${c('apim').params.sku}'`, `param apimPublisherEmail = ${bicepString(spec.tags.owner ?? '')}`, `param apimPublisherName = ${bicepString(`${spec.useCaseName} (${spec.tags.costCenter ?? 'no cost center'})`.slice(0, 100))}`);
    }
    if (has('bot')) lines.push(`param botSku = '${c('bot').params.sku}'`);
    return `${lines.join('\n')}\n`;
  };

  for (const env of TARGET_ENVS) {
    const ids = input.specsByEnv[env].components.map((c) => c.id).sort().join(',');
    if (ids !== spec.components.map((c) => c.id).sort().join(',')) notes.push(`The ${env} design has different components from the approved one; ${env} parameters use the approved component set.`);
  }

  // ---------------------------------------------------------------- pipeline
  const pipeline = tpl`# Deploys the infrastructure with OpenID Connect - no secrets in the repository (spec 11.3).
# Repository or environment variables: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID,
# AZURE_RESOURCE_GROUP. Add required reviewers to the test and prod environments for approvals.
name: deploy-infrastructure

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        type: choice
        options: [dev, test, prod]
        default: dev

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: #{{ inputs.environment }}
    env:
      RG: #{{ vars.AZURE_RESOURCE_GROUP }}
      PARAMS: infra/params/#{{ inputs.environment }}.bicepparam
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: #{{ vars.AZURE_CLIENT_ID }}
          tenant-id: #{{ vars.AZURE_TENANT_ID }}
          subscription-id: #{{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: Lint
        run: az bicep lint --file infra/main.bicep
      - name: What-if
        run: az deployment group what-if --resource-group "$RG" --template-file infra/main.bicep --parameters "$PARAMS"
      - name: Deploy
        run: az deployment group create --resource-group "$RG" --name "${input.workload}-#{{ inputs.environment }}-#{{ github.run_number }}" --template-file infra/main.bicep --parameters "$PARAMS"
`;

  // ---------------------------------------------------------------- inputs the generator will not invent
  if (isPrivate) {
    requiredInputs.push({ name: 'vnetAddressPrefix', where: 'infra/params/<env>.bicepparam', description: 'A /22 address range per environment for the spoke VNet, from the network team. Subnets are carved from it.', when: 'before-deploy' });
    if (dns.reuse.length) requiredInputs.push({ name: 'privateDnsZoneResourceGroupId', where: 'infra/params/<env>.bicepparam', description: `Resource ID of the resource group holding the shared zones ${dns.reuse.join(', ')}.`, when: 'before-deploy' });
    requiredInputs.push({ name: 'Shared private links', where: 'Azure portal: AI Services account and storage account > Networking > Private endpoint connections', description: 'Approve the two pending connections from Azure AI Search so the indexer and vectorizer can reach them privately.', when: 'after-deploy' });
    if (hub) requiredInputs.push({ name: 'Hub-side peering', where: 'Hub VNet (platform team)', description: 'Create the peering from the hub back to the spoke; the template only creates the spoke side.', when: 'after-deploy' });
  }
  requiredInputs.push({ name: 'containerImage', where: 'infra/params/<env>.bicepparam', description: 'The assistant API image. The default placeholder only proves the platform works.', when: 'before-deploy' });
  requiredInputs.push({ name: 'GitHub OIDC', where: 'Repository settings > Environments / Variables', description: 'A federated credential for an Entra app or managed identity with Contributor and User Access Administrator (role assignments) on the resource group; set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP.', when: 'before-deploy' });
  const unsetTags = Object.entries(spec.tags).filter(([, v]) => !v).map(([k]) => k);
  if (unsetTags.length) requiredInputs.push({ name: `Tag values: ${unsetTags.join(', ')}`, where: 'infra/params/<env>.bicepparam (tags)', description: 'Required tags with no value yet - set them, or policy may deny the deployment.', when: 'before-deploy' });
  if (has('bot')) notes.push('Azure Bot is a global resource, which allowed-locations policies normally exempt.');
  if (has('apim')) notes.push('API Management is created empty: import the assistant API and its policies (validate-jwt, token limits) once the API is published.');

  const root = `uc-${spec.useCaseId.slice(0, 8)}-${kebab(spec.useCaseName)}`;
  const files: IacFile[] = [
    { path: 'infra/main.bicep', content: mainBicep },
    ...(has('bot') ? [{ path: 'infra/modules/bot-service.bicep', content: botModule }] : []),
    ...TARGET_ENVS.map((env) => ({ path: `infra/params/${env}.bicepparam`, content: paramFile(env) })),
    { path: '.github/workflows/deploy.yml', content: pipeline },
    { path: 'docs/architecture.md', content: architectureDoc(spec, input.architectureVersion) },
    { path: 'README.md', content: readme(spec, input, root, requiredInputs, notes, regionAbbr) },
  ];
  return { root, workload: input.workload, files, requiredInputs, notes, generator: IAC_GENERATOR_ID };
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** docs/architecture.md - summary, diagram (Mermaid, rendered by GitHub), components, cost and ADRs. */
export function architectureDoc(spec: ArchitectureSpec, architectureVersion: number): string {
  const node = (id: string) => `n_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const label = (c: ArchitectureComponent) => `"${c.label.replace(/"/g, '#quot;')}${c.reuseExisting ? ' (existing)' : ''}"`;
  const mermaid = [
    'flowchart LR',
    ...ZONES.filter((z) => spec.components.some((c) => c.zone === z.id)).flatMap((z) => [
      `  subgraph ${z.id}["${z.label}"]`,
      ...spec.components.filter((c) => c.zone === z.id).map((c) => `    ${node(c.id)}[${label(c)}]`),
      '  end',
    ]),
    ...spec.connections.map((c) => `  ${node(c.from)} -->|${c.kind}| ${node(c.to)}`),
  ].join('\n');
  return `${[
    `# ${md(spec.useCaseName)} - architecture`,
    '',
    `ArchitectureSpec v${architectureVersion} (use case v${spec.specVersion}), ${spec.environment}, ${spec.region}. Rules ${spec.generator.rules}; text ${spec.generator.explainer}.`,
    '',
    spec.summary,
    '',
    '## Diagram',
    '',
    '```mermaid',
    mermaid,
    '```',
    '',
    '## Components',
    '',
    '| Component | Module | New or reused | Why |',
    '| --- | --- | --- | --- |',
    ...spec.components.map((c) => `| ${md(c.label)} | \`${c.module}\` | ${c.reuseExisting ? 'reused' : 'new'} | ${md(c.reason)} |`),
    '',
    '## Estimated monthly cost (directional)',
    '',
    '| Component | Item | Quantity | Monthly |',
    '| --- | --- | --- | ---: |',
    ...spec.cost.lineItems.map((l) => `| ${md(spec.components.find((c) => c.id === l.component)?.label ?? l.component)} | ${md(l.item)} | ${md(l.quantity)} | ${usd(l.monthlyUsd)} |`),
    `| **Total** | | | **${usd(spec.cost.monthlyUsd)}** |`,
    '',
    ...spec.cost.assumptions.map((a) => `- ${md(a)}`),
    '',
    '## Architecture decision records',
    '',
    ...spec.adrs.flatMap((a) => [`### ${a.id}: ${md(a.title)}`, '', `**Status:** ${a.status}  `, `**Context:** ${md(a.context)}  `, `**Decision:** ${md(a.decision)}  `, `**Consequences:** ${md(a.consequences)}`, '']),
    ...(spec.warnings.length ? ['## Open warnings', '', ...spec.warnings.map((w) => `- ${md(w)}`), ''] : []),
  ].join('\n')}\n`;
}

function readme(spec: ArchitectureSpec, input: IacInput, root: string, required: RequiredInput[], notes: string[], regionAbbr: string): string {
  const before = required.filter((r) => r.when === 'before-deploy');
  const after = required.filter((r) => r.when === 'after-deploy');
  return `${[
    `# ${md(spec.useCaseName)} - infrastructure`,
    '',
    `Generated by the Azure AI Factory Builder (${IAC_GENERATOR_ID}) from ArchitectureSpec v${input.architectureVersion}. Bundle \`${root}\`.`,
    '',
    `A RAG knowledge assistant in **${spec.region}** (\`${regionAbbr}\`), ${spec.private ? 'with private endpoints only' : 'with public endpoints secured by Entra ID'}. See [docs/architecture.md](docs/architecture.md) for the diagram, cost and decisions.`,
    '',
    '## Layout',
    '',
    '| Path | What |',
    '| --- | --- |',
    '| `infra/main.bicep` | All resources, composed from Azure Verified Modules pinned to explicit versions |',
    ...(spec.components.some((c) => c.id === 'bot') ? ['| `infra/modules/bot-service.bicep` | Azure Bot and Teams channel (no AVM module is published yet) |'] : []),
    '| `infra/params/{dev,test,prod}.bicepparam` | Sizing and names per environment |',
    '| `.github/workflows/deploy.yml` | Lint, what-if and deploy with OpenID Connect |',
    '| `docs/architecture.md` | Summary, diagram, cost estimate and ADRs |',
    '',
    '## Before the first deployment',
    '',
    ...before.map((r) => `- **${md(r.name)}** (${md(r.where)}): ${md(r.description)}`),
    '',
    '## Deploy',
    '',
    '```bash',
    `az deployment group what-if --resource-group <rg> --template-file infra/main.bicep --parameters infra/params/dev.bicepparam`,
    `az deployment group create  --resource-group <rg> --template-file infra/main.bicep --parameters infra/params/dev.bicepparam`,
    '```',
    '',
    'Or run the **deploy-infrastructure** workflow and pick the environment.',
    '',
    ...(after.length ? ['## After deployment', '', ...after.map((r) => `- **${md(r.name)}** (${md(r.where)}): ${md(r.description)}`), ''] : []),
    '## Security',
    '',
    '- One user-assigned managed identity; every service grants it a role. Local keys are disabled on the model, search, storage, Key Vault' + (spec.components.some((c) => c.id === 'cosmos') ? ', Cosmos DB' : '') + ' and Application Insights.',
    '- No secrets, keys or connection strings are in these files or in the deployment outputs.',
    `- Tags on every resource: ${Object.keys(spec.tags).map((t) => `\`${t}\``).join(', ')}.`,
    '- Content Safety (the default responsible-AI policy) is set on every model deployment.',
    '',
    ...(notes.length ? ['## Notes', '', ...notes.map((n) => `- ${md(n)}`), ''] : []),
  ].join('\n')}\n`;
}
