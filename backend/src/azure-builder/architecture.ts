/**
 * Azure AI Factory Builder - Phase 3 (Architect) core.
 *
 * A deterministic rules engine (spec 4.4, 8.3) that turns a UseCaseSpec and an
 * Environment Profile into an ArchitectureSpec (spec 6.4): components from the
 * pattern catalog (config/azure-builder.yaml), the connections between them,
 * decisions with ADR drafts, mandatory tags and a cost estimate with line
 * items and assumptions. No LLM: the ADRs and the summary are templates over
 * the spec, so they describe only components that are in it (spec 10.3).
 * Pure - no I/O.
 */
import { EnvironmentProfile } from './environment-profile';
import { DataRefresh, UseCaseSpec } from './use-case-spec';

export type Zone = 'edge' | 'app' | 'ai' | 'data' | 'network' | 'monitoring';
export const ZONES: Array<{ id: Zone; label: string }> = [
  { id: 'edge', label: 'Entry' },
  { id: 'app', label: 'Application' },
  { id: 'ai', label: 'AI models' },
  { id: 'data', label: 'Data and secrets' },
  { id: 'network', label: 'Network' },
  { id: 'monitoring', label: 'Monitoring' },
];

export type ConnectionKind =
  | 'https'
  | 'private-endpoint'
  | 'shared-private-link'
  | 'identity'
  | 'indexer'
  | 'hosted-in'
  | 'telemetry'
  | 'diagnostics'
  | 'workspace'
  | 'subnet'
  | 'dns-zone'
  | 'peering';

export type DeploymentSku = 'GlobalStandard' | 'DataZoneStandard' | 'Standard' | 'ProvisionedManaged';

/** What the architect can toggle (spec 4.4: "toggle optional components, e.g. APIM gateway, PTU"). */
export interface ArchitectureOptions {
  /** null lets the rules decide (on for external or mixed users). */
  apiGateway: boolean | null;
  chatHistory: boolean;
  deployment: 'auto' | 'payg' | 'ptu';
}
export const DEFAULT_OPTIONS: ArchitectureOptions = { apiGateway: null, chatHistory: false, deployment: 'auto' };

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
  /** Why the rules included it (or reuse it). */
  reason: string;
}

export interface ArchitectureConnection { from: string; to: string; kind: ConnectionKind }

export interface Adr {
  id: string;
  title: string;
  status: 'proposed';
  context: string;
  decision: string;
  consequences: string;
  /** Short form for the spec's `decisions` list. */
  choice: string;
}

export interface CostLineItem {
  component: string;
  item: string;
  quantity: string;
  monthlyUsd: number;
  oneTimeUsd: number;
  basis: string;
}

export interface CostEstimate {
  currency: 'USD';
  monthlyUsd: number;
  oneTimeUsd: number;
  lineItems: CostLineItem[];
  assumptions: string[];
  rateCard: { version: string; lastReviewed: string; source: string };
  budgetUsd: number | null;
  overBudget: boolean;
  /** Both deployment options priced, so the PTU toggle's impact is visible. */
  modelOptions: { paygMonthlyUsd: number; ptuMonthlyUsd: number; ptuUnits: number };
}

export interface ArchitectureSizing {
  monthlyRequests: number;
  peakTpm: number;
  documentGb: number;
  corpusTokens: number;
  chunks: number;
  vectorGb: number;
  indexGb: number;
  searchTier: string;
  searchReplicas: number;
  searchPartitions: number;
  deploymentSku: DeploymentSku;
  /** Thousand tokens/min for pay-as-you-go deployments; PTUs for provisioned. */
  deploymentCapacity: number;
}

export interface ArchitectureSpec {
  useCaseId: string;
  useCaseName: string;
  specVersion: number;
  profileVersion: number;
  pattern: 'rag-assistant';
  region: string;
  environment: string;
  private: boolean;
  options: ArchitectureOptions;
  sizing: ArchitectureSizing;
  components: ArchitectureComponent[];
  connections: ArchitectureConnection[];
  decisions: Array<{ adr: string; choice: string; reason: string }>;
  adrs: Adr[];
  tags: Record<string, string | null>;
  cost: CostEstimate;
  summary: string;
  warnings: string[];
  generator: { rules: string; explainer: string };
}

/** The parts of config/azure-builder.yaml the engine reads. */
export interface AzureCatalog {
  rulesVersion: string;
  lastReviewed: string;
  hoursPerMonth: number;
  patterns: { 'rag-assistant': { components: Record<string, { type: string; label: string; module: string; zone: Zone }> } };
  privateDnsZones: Record<string, string[]>;
  models: { chat: string; embedding: string; embeddingDimensions: number; embeddingCapacityK: number; queryEmbeddingTokens: number };
  dataZones: Record<string, string[]>;
  ptu: { thresholdTpm: number; tpmPerPtu: number; minimumPtu: number };
  workload: {
    requestsPerUserPerMonth: number;
    requestsPerConcurrentUserPerMinute: number;
    inputTokensPerRequest: number;
    outputTokensPerRequest: number;
    extractableTextRatio: number;
    bytesPerToken: number;
    tokensPerChunk: number;
    indexOverheadRatio: number;
    monthlyChangedShare: Record<DataRefresh, number>;
    logGbPerMonth: Record<string, number>;
    chatHistoryRuPerRequest: number;
    chatHistoryKbPerRequest: number;
    apiReplicas: Record<string, number>;
    apiReplicaSize: { vcpu: number; gib: number };
  };
  searchTiers: Array<{ tier: string; vectorGbPerPartition: number; storageGbPerPartition: number; maxPartitions: number }>;
  searchReplicas: Array<{ minAvailability: number; replicas: number }>;
  rates: {
    models: Record<string, { inputPer1M: number; outputPer1M?: number }>;
    regionalDeploymentUplift: number;
    ptuHour: number;
    searchUnitMonth: Record<string, number>;
    containerApps: { vcpuSecond: number; gibSecond: number };
    storageGbMonth: { lrs: number; zrs: number };
    keyVaultMonth: number;
    logAnalyticsPerGb: number;
    privateEndpointHour: number;
    privateDnsZoneMonth: number;
    apimMonth: { developer: number; standardv2: number };
    cosmosServerless: { per1MRu: number; gbMonth: number };
  };
}

export interface ArchitectureInput {
  useCase: UseCaseSpec;
  useCaseId: string;
  useCaseVersion: number;
  profile: EnvironmentProfile;
  profileVersion: number;
  connection: { region: string; deploymentModel: string };
  options: ArchitectureOptions;
  catalog: AzureCatalog;
}

/** A design the rules cannot produce (unsupported pattern, no allowed region). Shown to the user as-is. */
export class ArchitectureError extends Error {}

export const ARCHITECT_EXPLAINER_ID = 'template-v1';
const MANDATORY_TAGS = ['useCaseId', 'owner', 'costCenter', 'environment', 'createdBy'];

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const lower = (s: string) => s.trim().toLowerCase();

/**
 * Picks the deployment region. Candidates are the use case's regions and the
 * allowed-locations policy (both when both are set); the connection's region
 * wins if it is a candidate. No candidate -> no design (spec 4.4 acceptance:
 * no component in a region the policy disallows).
 */
export function chooseRegion(useCaseRegions: string[], policyRegions: string[], target: string): { region: string; candidates: string[]; reason: string } {
  const uc = useCaseRegions.map(lower);
  const policy = policyRegions.map(lower);
  const t = lower(target);
  const candidates = uc.length && policy.length ? uc.filter((r) => policy.includes(r)) : uc.length ? uc : policy.length ? policy : [t];
  if (!candidates.length) {
    throw new ArchitectureError(`No region satisfies both the use case (${uc.join(', ')}) and the allowed-locations policy (${policy.join(', ')}). Change the use case regions in Phase 2 or the policy.`);
  }
  if (candidates.includes(t)) return { region: t, candidates, reason: `The connection's target region ${t} is allowed${policy.length ? ' by policy' : ''}${uc.length ? ' and listed by the use case' : ''}.` };
  return { region: candidates[0], candidates, reason: `The connection's target region ${t} is not allowed, so the first allowed region (${candidates[0]}) is used. Update the Phase 0 connection to match before deploying.` };
}

export function dataZoneOf(region: string, catalog: AzureCatalog): string | null {
  return Object.entries(catalog.dataZones).find(([, regions]) => regions.includes(region))?.[0] ?? null;
}

/** Deterministic rules engine: UseCaseSpec + EnvironmentProfile -> ArchitectureSpec. */
export function designArchitecture(input: ArchitectureInput): ArchitectureSpec {
  const { useCase: uc, profile, catalog: cat, options } = input;
  if (uc.pattern.id !== 'rag-assistant') {
    throw new ArchitectureError(`Phase 3 designs only the RAG knowledge assistant in this release; this use case is ${uc.pattern.id}. Override the pattern in Phase 2 if a RAG assistant fits.`);
  }
  const warnings: string[] = [];
  const env = uc.environment;
  const w = cat.workload;

  // ---- Region (rule: restrict to allowed locations) ----
  const { region, candidates, reason: regionReason } = chooseRegion(uc.constraints.regions, profile.policy.allowedLocations, input.connection.region);
  if (region !== lower(input.connection.region)) warnings.push(regionReason);

  // ---- Sizing ----
  const tokensPerRequest = w.inputTokensPerRequest + w.outputTokensPerRequest;
  const monthlyRequests = uc.users.count * w.requestsPerUserPerMonth;
  const peakTpm = Math.round(uc.users.peakConcurrent * w.requestsPerConcurrentUserPerMinute * tokensPerRequest);
  const documentGb = uc.data.reduce((s, d) => s + d.volumeGb, 0);
  const tokensOf = (gb: number) => (gb * w.extractableTextRatio * 1e9) / w.bytesPerToken;
  const corpusTokens = Math.round(tokensOf(documentGb));
  const chunks = Math.ceil(corpusTokens / w.tokensPerChunk);
  const vectorGb = (chunks * cat.models.embeddingDimensions * 4) / 1e9;
  const indexGb = documentGb * w.extractableTextRatio * w.indexOverheadRatio + vectorGb;
  if (!uc.data.length) warnings.push('The use case lists no data sources, so the search index is sized at the minimum. Add data sources in Phase 2.');

  const tiers = env === 'prod' ? cat.searchTiers.filter((t) => t.tier !== 'basic') : cat.searchTiers;
  const partitionsFor = (t: AzureCatalog['searchTiers'][number]) => Math.max(1, Math.ceil(vectorGb / t.vectorGbPerPartition), Math.ceil(indexGb / t.storageGbPerPartition));
  const tier = tiers.find((t) => partitionsFor(t) <= t.maxPartitions) ?? tiers[tiers.length - 1];
  const searchPartitions = Math.min(partitionsFor(tier), tier.maxPartitions);
  if (partitionsFor(tier) > tier.maxPartitions) warnings.push(`The index (~${indexGb.toFixed(1)} GB) exceeds one ${tier.tier} search service - split it across services or confirm sizing with the search team.`);
  const availability = Number.parseFloat(uc.constraints.availability ?? '') || 99.9;
  const searchReplicas = env === 'prod' ? (cat.searchReplicas.find((r) => availability >= r.minAvailability)?.replicas ?? 1) : 1;

  // ---- Network isolation (rule: private endpoints if policy requires; spec 11.1: or data is confidential) ----
  const sensitive = uc.data.filter((d) => d.classification === 'confidential' || d.classification === 'restricted' || d.containsPersonalData);
  const isPrivate = profile.policy.denyPublicNetworkAccess || sensitive.length > 0;
  const privateWhy = profile.policy.denyPublicNetworkAccess
    ? 'Azure Policy denies public network access'
    : sensitive.length
      ? `the data includes ${sensitive.some((d) => d.containsPersonalData) ? 'personal' : 'confidential or restricted'} information (${sensitive.map((d) => d.source).join(', ')})`
      : 'no policy requires it and the data is not confidential';
  const pna = isPrivate ? 'Disabled' : 'Enabled';

  // ---- Model deployment (rule: capacity -> PTU, else pay-as-you-go by residency) ----
  const ptuUnits = Math.max(cat.ptu.minimumPtu, Math.ceil(peakTpm / cat.ptu.tpmPerPtu));
  const usePtu = options.deployment === 'ptu' || (options.deployment === 'auto' && peakTpm > cat.ptu.thresholdTpm);
  const zone = dataZoneOf(region, cat);
  const denied = profile.policy.deniedSkus.map(lower);
  let paygSku: DeploymentSku = uc.constraints.dataResidency ? (zone ? 'DataZoneStandard' : 'Standard') : 'GlobalStandard';
  if (denied.includes(lower(paygSku)) && paygSku !== 'Standard') {
    warnings.push(`Policy denies the ${paygSku} deployment type, so regional Standard is used.`);
    paygSku = 'Standard';
  }
  if (denied.includes('standard') && paygSku === 'Standard') warnings.push('Policy denies the Standard deployment type too - agree an allowed deployment type with the platform team.');
  const deploymentSku: DeploymentSku = usePtu ? 'ProvisionedManaged' : paygSku;
  const deploymentCapacity = usePtu ? ptuUnits : Math.max(1, Math.ceil(peakTpm / 1000));
  const quota = profile.ai.modelQuota.find((q) => lower(q.region) === region && lower(q.model) === lower(cat.models.chat) && lower(q.sku) === lower(deploymentSku));
  if (!quota) warnings.push(`No ${cat.models.chat} quota for ${deploymentSku} in ${region} is recorded in the Environment Profile - confirm quota before deploying.`);
  else if (!usePtu && deploymentCapacity * 1000 > quota.limitTpm - quota.usedTpm) {
    warnings.push(`The design needs ${fmt(deploymentCapacity * 1000)} TPM of ${cat.models.chat} but only ${fmt(quota.limitTpm - quota.usedTpm)} is free in ${region} - request a quota increase.`);
  }
  if (options.deployment === 'ptu' && peakTpm <= cat.ptu.thresholdTpm) warnings.push(`Provisioned throughput was chosen although peak demand (~${fmt(peakTpm)} TPM) is below the ${fmt(cat.ptu.thresholdTpm)} TPM threshold - compare the two model costs below.`);

  // ---- Optional components ----
  const apiGateway = options.apiGateway ?? uc.users.type !== 'internal';
  const chatHistory = options.chatHistory;
  const teams = uc.users.channels.includes('teams');
  const hubId = isPrivate ? profile.network.hubVnetId : null;
  const laId = profile.monitoring.logAnalyticsId;

  // ---- Components ----
  const defs = cat.patterns['rag-assistant'].components;
  const components: ArchitectureComponent[] = [];
  const add = (id: string, params: Record<string, unknown>, reason: string, extra: Partial<Pick<ArchitectureComponent, 'reuseExisting' | 'resourceId' | 'optional'>> = {}) => {
    const d = defs[id];
    if (!d) throw new Error(`Catalog has no component "${id}"`);
    components.push({ id, type: d.type, label: d.label, module: d.module, zone: d.zone, params, reuseExisting: false, resourceId: null, optional: false, reason, ...extra });
  };

  const peTargets = ['aoai', 'search', 'storage', 'keyvault', ...(chatHistory ? ['cosmos'] : [])];
  if (apiGateway) {
    add('apim', { sku: env === 'dev' ? 'Developer' : 'StandardV2', policies: ['validate-jwt', 'rate-limit-by-key', 'azure-openai-token-limit', 'azure-openai-emit-token-metric'], virtualNetworkIntegration: isPrivate },
      options.apiGateway === null ? `AI gateway added because users are ${uc.users.type}: authentication, rate and token limits at the edge.` : 'AI gateway turned on by the architect.', { optional: true });
  }
  if (teams) add('bot', { sku: env === 'dev' ? 'F0' : 'S1', channels: ['MsTeamsChannel'], msaAppType: 'UserAssignedMSI', messagingEndpoint: apiGateway ? 'via API Management' : 'assistant API' }, 'Teams is a user channel (rule: channels contains teams -> bot service).');
  add('identity', {}, 'One identity for the assistant; access to every service is by RBAC, never by keys.');
  add('cae', { workloadProfile: 'Consumption', internal: isPrivate && uc.users.type === 'internal', infrastructureSubnet: isPrivate ? 'snet-apps' : null }, 'Serverless container hosting for the assistant API.');
  const replicas = w.apiReplicas[env] ?? 1;
  add('app', { minReplicas: replicas, cpu: w.apiReplicaSize.vcpu, memoryGi: w.apiReplicaSize.gib, ingress: isPrivate && uc.users.type === 'internal' && !apiGateway ? 'internal' : 'external', identity: 'identity' }, 'Runs the retrieval and generation logic.');
  add('aoai', {
    kind: 'AIServices',
    sku: 'S0',
    publicNetworkAccess: pna,
    disableLocalAuth: true,
    deployments: [
      { name: 'chat', model: cat.models.chat, sku: deploymentSku, capacity: deploymentCapacity },
      { name: 'embedding', model: cat.models.embedding, sku: paygSku, capacity: cat.models.embeddingCapacityK, dimensions: cat.models.embeddingDimensions },
    ],
  }, 'Required by the RAG pattern: the chat and embedding models.');
  add('search', { sku: tier.tier, replicaCount: searchReplicas, partitionCount: searchPartitions, publicNetworkAccess: pna, disableLocalAuth: true, semanticRanker: tier.tier === 'basic' ? 'free' : 'standard' }, 'Required by the RAG pattern: the vector and keyword index.');
  add('storage', { skuName: env === 'prod' ? 'Standard_ZRS' : 'Standard_LRS', kind: 'StorageV2', publicNetworkAccess: pna, allowSharedKeyAccess: false, containers: ['documents'] }, 'Required by the RAG pattern: the source documents.');
  add('keyvault', { sku: 'standard', enableRbacAuthorization: true, enablePurgeProtection: env === 'prod', publicNetworkAccess: pna }, 'Required by the RAG pattern: any secret the app cannot avoid (e.g. a third-party key).');
  if (chatHistory) add('cosmos', { capacityMode: 'Serverless', publicNetworkAccess: pna, disableLocalAuth: true, containers: ['conversations'] }, 'Chat history turned on by the architect.', { optional: true });
  if (laId) add('log-analytics', {}, 'Reuse the existing workspace found by Discover (rule: Log Analytics found -> reuse).', { reuseExisting: true, resourceId: laId });
  else add('log-analytics', { retentionInDays: env === 'prod' ? 90 : 30 }, 'No workspace was found by Discover, so one is created.');
  add('app-insights', { workspace: 'log-analytics' }, 'Request tracing and model-call telemetry for the assistant.');

  const neededZones = [...new Set(peTargets.flatMap((t) => cat.privateDnsZones[t] ?? []))];
  const reuseZones = neededZones.filter((z) => profile.network.privateDnsZones.includes(z));
  const createZones = neededZones.filter((z) => !reuseZones.includes(z));
  if (isPrivate) {
    add('vnet', { addressSpace: null, subnets: ['snet-apps (/23, Container Apps)', 'snet-private-endpoints (/27)'], peerToHub: hubId }, hubId ? 'Spoke network for the use case, peered to the existing hub.' : 'Network for the private endpoints and the app; no hub was found.');
    warnings.push('The spoke VNet needs an address range (a /22 is enough) from the network team before Phase 4.');
    if (hubId) add('hub-vnet', {}, 'Existing hub found by Discover (rule: reuse hub if found).', { reuseExisting: true, resourceId: hubId });
    add('private-endpoints', { targets: peTargets, subnet: 'snet-private-endpoints' }, `Private access only, because ${privateWhy}.`);
    add('private-dns', { reuse: reuseZones, create: createZones }, createZones.length ? `${reuseZones.length} zone(s) reused from the hub, ${createZones.length} created.` : 'All the zones exist already and are reused.', { reuseExisting: createZones.length === 0 });
  }

  // ---- Connections ----
  const has = (id: string) => components.some((c) => c.id === id);
  const connections: ArchitectureConnection[] = [];
  const link = (from: string, to: string, kind: ConnectionKind) => { if (has(from) && has(to)) connections.push({ from, to, kind }); };
  const dataKind: ConnectionKind = isPrivate ? 'private-endpoint' : 'https';
  link('apim', 'app', 'https');
  link('bot', apiGateway ? 'apim' : 'app', 'https');
  link('app', 'cae', 'hosted-in');
  link('app', 'identity', 'identity');
  for (const t of peTargets) link('app', t, dataKind);
  link('search', 'storage', 'indexer');
  link('search', 'aoai', isPrivate ? 'shared-private-link' : 'https');
  link('app', 'app-insights', 'telemetry');
  link('app-insights', 'log-analytics', 'workspace');
  for (const id of ['apim', 'aoai', 'search', 'storage', 'keyvault', 'cosmos', 'cae']) link(id, 'log-analytics', 'diagnostics');
  link('cae', 'vnet', 'subnet');
  link('private-endpoints', 'vnet', 'subnet');
  link('private-endpoints', 'private-dns', 'dns-zone');
  link('vnet', 'hub-vnet', 'peering');

  // ---- Tags (spec 11.1: mandatory on every resource, plus what policy requires) ----
  const tags: Record<string, string | null> = { useCaseId: input.useCaseId, owner: uc.owner || null, costCenter: uc.business.costCenter || null, environment: env, createdBy: 'ai-factory-builder' };
  for (const t of profile.policy.requiredTags) if (!(t in tags)) tags[t] = null;
  const unset = Object.entries(tags).filter(([, v]) => !v).map(([k]) => k);
  if (unset.length) warnings.push(`Tag${unset.length > 1 ? 's' : ''} ${unset.join(', ')} ${unset.length > 1 ? 'have' : 'has'} no value yet${profile.policy.requiredTags.some((t) => unset.includes(t)) ? ' (required by policy)' : ''} - set ${unset.length > 1 ? 'them' : 'it'} before Phase 4.`);

  const sizing: ArchitectureSizing = {
    monthlyRequests, peakTpm, documentGb: round2(documentGb), corpusTokens, chunks, vectorGb: round2(vectorGb), indexGb: round2(indexGb),
    searchTier: tier.tier, searchReplicas, searchPartitions, deploymentSku, deploymentCapacity,
  };

  const cost = estimateCost({ uc, cat, components, sizing, paygSku, ptuUnits, laReused: !!laId, createZones, peCount: isPrivate ? peTargets.length : 0, region });
  if (cost.overBudget) warnings.push(`The estimate (${money(cost.monthlyUsd)}/month) is over the use case budget (${money(cost.budgetUsd!)}/month).`);

  const adrs = draftAdrs({ uc, cat, region, candidates, regionReason, isPrivate, privateWhy, sizing, paygSku, usePtu, peakTpm, cost, apiGateway, chatHistory, teams, options, hubId, laId, reuseZones, createZones, zone });
  const spec: ArchitectureSpec = {
    useCaseId: input.useCaseId,
    useCaseName: uc.name,
    specVersion: input.useCaseVersion,
    profileVersion: input.profileVersion,
    pattern: 'rag-assistant',
    region,
    environment: env,
    private: isPrivate,
    options,
    sizing,
    components,
    connections,
    decisions: adrs.map((a) => ({ adr: a.id, choice: a.choice, reason: a.decision })),
    adrs,
    tags,
    cost,
    summary: summarise(uc, region, isPrivate, components, sizing, cost),
    warnings,
    generator: { rules: cat.rulesVersion, explainer: ARCHITECT_EXPLAINER_ID },
  };
  const problems = validateArchitecture(spec, profile.policy.allowedLocations);
  if (problems.length) throw new Error(`Rules engine produced an inconsistent design: ${problems.join('; ')}`);
  return spec;
}

interface CostInput {
  uc: UseCaseSpec;
  cat: AzureCatalog;
  components: ArchitectureComponent[];
  sizing: ArchitectureSizing;
  paygSku: DeploymentSku;
  ptuUnits: number;
  laReused: boolean;
  createZones: string[];
  peCount: number;
  region: string;
}

/** Monthly estimate: one line per component (zero-cost ones included, so every component is accounted for). */
export function estimateCost(x: CostInput): CostEstimate {
  const { uc, cat, sizing: s } = x;
  const r = cat.rates;
  const w = cat.workload;
  const h = cat.hoursPerMonth;
  const env = uc.environment;
  const lines: CostLineItem[] = [];
  const line = (component: string, item: string, quantity: string, monthlyUsd: number, basis: string, oneTimeUsd = 0) =>
    lines.push({ component, item, quantity, monthlyUsd: round2(monthlyUsd), oneTimeUsd: round2(oneTimeUsd), basis });
  const has = (id: string) => x.components.some((c) => c.id === id);

  const chat = r.models[cat.models.chat];
  const emb = r.models[cat.models.embedding];
  const uplift = x.paygSku === 'GlobalStandard' ? 1 : r.regionalDeploymentUplift;
  const paygMonthly = ((s.monthlyRequests * (w.inputTokensPerRequest * chat.inputPer1M + w.outputTokensPerRequest * (chat.outputPer1M ?? 0))) / 1e6) * uplift;
  const ptuMonthly = x.ptuUnits * r.ptuHour * h;
  const usePtu = s.deploymentSku === 'ProvisionedManaged';
  if (usePtu) line('aoai', `${cat.models.chat} provisioned throughput`, `${x.ptuUnits} PTU x ${h} h`, ptuMonthly, `${money(r.ptuHour)} per PTU-hour, hourly (no reservation)`);
  else line('aoai', `${cat.models.chat} tokens (${x.paygSku})`, `${fmt(s.monthlyRequests)} requests`, paygMonthly,
    `${fmt(w.inputTokensPerRequest)} in + ${fmt(w.outputTokensPerRequest)} out tokens per request at ${money(chat.inputPer1M)} / ${money(chat.outputPer1M ?? 0)} per 1M${uplift !== 1 ? `, +${Math.round((uplift - 1) * 100)}% for ${x.paygSku}` : ''}`);
  const changed = uc.data.reduce((sum, d) => sum + ((d.volumeGb * w.extractableTextRatio * 1e9) / w.bytesPerToken) * (w.monthlyChangedShare[d.refresh] ?? 0), 0);
  const embTokens = changed + s.monthlyRequests * cat.models.queryEmbeddingTokens;
  line('aoai', `${cat.models.embedding} embeddings`, `${fmt(embTokens / 1e6)}M tokens/month`, (embTokens * emb.inputPer1M * uplift) / 1e6,
    `Changed documents re-embedded each month plus ${cat.models.queryEmbeddingTokens} tokens per question; first full index is one-time`, (s.corpusTokens * emb.inputPer1M * uplift) / 1e6);

  const units = s.searchReplicas * s.searchPartitions;
  line('search', `AI Search ${s.searchTier}`, `${s.searchReplicas} replica(s) x ${s.searchPartitions} partition(s)`, units * (r.searchUnitMonth[s.searchTier] ?? 0), `${money(r.searchUnitMonth[s.searchTier] ?? 0)} per search unit-month; index ~${s.indexGb} GB (${fmt(s.chunks)} chunks)`);

  const replicas = w.apiReplicas[env] ?? 1;
  const seconds = h * 3600;
  line('app', 'Container App (always on)', `${replicas} x ${w.apiReplicaSize.vcpu} vCPU / ${w.apiReplicaSize.gib} GiB`, replicas * seconds * (w.apiReplicaSize.vcpu * r.containerApps.vcpuSecond + w.apiReplicaSize.gib * r.containerApps.gibSecond), 'Consumption plan active rates, minimum replicas kept warm; the monthly free grant is ignored');
  line('cae', 'Container Apps environment', '1', 0, 'Consumption environment has no fixed charge');
  const zrs = env === 'prod';
  line('storage', `Blob storage (${zrs ? 'ZRS' : 'LRS'}, hot)`, `${s.documentGb} GB`, s.documentGb * (zrs ? r.storageGbMonth.zrs : r.storageGbMonth.lrs), 'Capacity only; transactions are negligible at this scale');
  line('keyvault', 'Key Vault operations', '1 vault', r.keyVaultMonth, 'Allowance for secret reads');
  line('identity', 'Managed identity', '1', 0, 'No charge');
  if (has('cosmos')) {
    const ru = (s.monthlyRequests * w.chatHistoryRuPerRequest) / 1e6;
    const gb = (s.monthlyRequests * w.chatHistoryKbPerRequest) / 1e6;
    line('cosmos', 'Cosmos DB serverless', `${ru.toFixed(1)}M RU + ${gb.toFixed(2)} GB`, ru * r.cosmosServerless.per1MRu + gb * r.cosmosServerless.gbMonth, `${w.chatHistoryRuPerRequest} RU and ${w.chatHistoryKbPerRequest} KB per request; storage grows each month`);
  }
  if (has('apim')) {
    const dev = env === 'dev';
    line('apim', `API Management ${dev ? 'Developer' : 'Standard v2'}`, '1 unit', dev ? r.apimMonth.developer : r.apimMonth.standardv2, dev ? 'Developer tier has no SLA - not for production' : 'Standard v2 supports VNet integration');
  }
  if (has('bot')) line('bot', 'Azure Bot (Teams)', '1', 0, 'Teams is a standard channel - no message charge');
  const logGb = w.logGbPerMonth[env] ?? 5;
  line('log-analytics', `Log ingestion${x.laReused ? ' (billed to the shared workspace)' : ''}`, `${logGb} GB/month`, logGb * r.logAnalyticsPerGb, `${money(r.logAnalyticsPerGb)} per GB, analytics logs, pay-as-you-go`);
  line('app-insights', 'Application Insights', '1', 0, 'Workspace-based: ingestion is counted under Log Analytics');
  if (has('vnet')) line('vnet', 'Virtual network', '1', 0, 'No charge; hub peering data transfer is excluded');
  if (has('hub-vnet')) line('hub-vnet', 'Existing hub', '-', 0, 'Already paid for by the platform team');
  if (has('private-endpoints')) line('private-endpoints', 'Private endpoints', `${x.peCount}`, x.peCount * r.privateEndpointHour * h, `${money(r.privateEndpointHour)} per endpoint-hour; data processed is excluded`);
  if (has('private-dns')) line('private-dns', 'Private DNS zones (new)', `${x.createZones.length}`, x.createZones.length * r.privateDnsZoneMonth, `${money(r.privateDnsZoneMonth)} per zone-month; reused zones are already paid for`);

  const monthlyUsd = round2(lines.reduce((t, l) => t + l.monthlyUsd, 0));
  const oneTimeUsd = round2(lines.reduce((t, l) => t + l.oneTimeUsd, 0));
  const budget = uc.constraints.monthlyBudgetUsd;
  return {
    currency: 'USD',
    monthlyUsd,
    oneTimeUsd,
    lineItems: lines,
    assumptions: [
      `${fmt(uc.users.count)} users x ${w.requestsPerUserPerMonth} questions each per month = ${fmt(s.monthlyRequests)} requests.`,
      `Peak demand: ${fmt(uc.users.peakConcurrent)} concurrent users x ${w.requestsPerConcurrentUserPerMinute} requests/min x ${fmt(w.inputTokensPerRequest + w.outputTokensPerRequest)} tokens = ~${fmt(s.peakTpm)} tokens/min.`,
      `${Math.round(w.extractableTextRatio * 100)}% of document bytes is extractable text, ~${w.bytesPerToken} bytes per token, ${w.tokensPerChunk}-token chunks, ${cat.models.embeddingDimensions}-dimension vectors.`,
      `${fmt(cat.hoursPerMonth)} hours per month; everything runs all month.`,
      `Rates are directional pay-as-you-go list prices (rate card ${cat.rulesVersion}, reviewed ${cat.lastReviewed}), not quotes; prices in ${x.region} can differ. The live-Azure wave uses the Azure Retail Prices API.`,
      'Excluded: data egress, hub peering transfer, Defender for Cloud, support plans, build and run effort.',
    ],
    rateCard: { version: cat.rulesVersion, lastReviewed: cat.lastReviewed, source: 'Directional list prices in config/azure-builder.yaml (offline)' },
    budgetUsd: budget,
    overBudget: budget != null && monthlyUsd > budget,
    modelOptions: { paygMonthlyUsd: round2(paygMonthly), ptuMonthlyUsd: round2(ptuMonthly), ptuUnits: x.ptuUnits },
  };
}

interface AdrInput {
  uc: UseCaseSpec;
  cat: AzureCatalog;
  region: string;
  candidates: string[];
  regionReason: string;
  isPrivate: boolean;
  privateWhy: string;
  sizing: ArchitectureSizing;
  paygSku: DeploymentSku;
  usePtu: boolean;
  peakTpm: number;
  cost: CostEstimate;
  apiGateway: boolean;
  chatHistory: boolean;
  teams: boolean;
  options: ArchitectureOptions;
  hubId: string | null;
  laId: string | null;
  reuseZones: string[];
  createZones: string[];
  zone: string | null;
}

/** ADR drafts from the decisions the rules made. Templates only - they cannot mention a component the spec lacks. */
export function draftAdrs(a: AdrInput): Adr[] {
  const s = a.sizing;
  const adr = (id: string, title: string, choice: string, context: string, decision: string, consequences: string): Adr => ({ id, title, status: 'proposed', choice, context, decision, consequences });
  const skuWhy = a.uc.constraints.dataResidency
    ? a.zone
      ? `data must stay in ${a.uc.constraints.dataResidency}, and ${a.region} is in the ${a.zone} data zone`
      : `data must stay in ${a.uc.constraints.dataResidency}, and ${a.region} is not in a data zone, so processing stays in the region`
    : 'there is no data residency requirement, so global routing gives the most capacity';
  const out: Adr[] = [
    adr('ADR-01', 'Deployment region', a.region,
      `Use case regions: ${a.uc.constraints.regions.join(', ') || 'none given'}. Allowed by policy: ${a.candidates.join(', ')}.${a.uc.constraints.dataResidency ? ` Data residency: ${a.uc.constraints.dataResidency}.` : ''}`,
      `Deploy every component in ${a.region}. ${a.regionReason}`,
      'A second region for disaster recovery is not part of this design; add it before a business-critical launch.'),
    adr('ADR-02', 'Network isolation', a.isPrivate ? 'Private endpoints, public access disabled' : 'Public endpoints with Entra ID authentication',
      `Public network access policy: ${a.isPrivate ? 'restricted' : 'not restricted'}. Data classification: ${a.uc.data.map((d) => `${d.source} (${d.classification}${d.containsPersonalData ? ', personal data' : ''})`).join('; ') || 'not given'}.`,
      a.isPrivate ? `All data and model services are reached only through private endpoints, because ${a.privateWhy}.` : `Services keep public endpoints but accept only Entra ID tokens (local keys disabled), because ${a.privateWhy}.`,
      a.isPrivate ? 'Needs a spoke VNet address range and DNS resolution through private DNS zones; developers reach the services through the hub or a jump host.' : 'Simpler to run; revisit if the data classification rises or policy changes.'),
    adr('ADR-03', 'Model deployment type', a.usePtu ? `Provisioned throughput (${s.deploymentCapacity} PTU)` : `Pay-as-you-go ${a.paygSku}`,
      `Peak demand is about ${fmt(a.peakTpm)} tokens/min against a provisioned-throughput threshold of ${fmt(a.cat.ptu.thresholdTpm)}. Pay-as-you-go would cost about ${money(a.cost.modelOptions.paygMonthlyUsd)}/month; ${a.cost.modelOptions.ptuUnits} PTU about ${money(a.cost.modelOptions.ptuMonthlyUsd)}/month.`,
      a.usePtu
        ? `Use provisioned throughput for ${a.cat.models.chat}${a.options.deployment === 'ptu' ? ' (chosen by the architect)' : ' because peak demand is above the threshold'}: predictable latency at high load.`
        : `Use ${a.paygSku} for ${a.cat.models.chat} with ${s.deploymentCapacity}K tokens/min, because ${skuWhy}${a.options.deployment === 'payg' ? ' (pay-as-you-go chosen by the architect)' : ''}.`,
      a.usePtu ? 'Cost is fixed whether or not the capacity is used; consider a monthly or yearly reservation once usage is proven.' : 'Cost follows usage; latency can vary at peak and is limited by the quota in the region.'),
    adr('ADR-04', 'Reuse of shared platform services', [a.laId && 'Log Analytics', a.hubId && 'hub VNet', a.reuseZones.length && 'DNS zones'].filter(Boolean).join(', ') || 'Nothing reused',
      'Discover looked for an existing hub VNet, Log Analytics workspace and private DNS zones.',
      [
        a.laId ? 'Send diagnostics to the existing Log Analytics workspace.' : 'Create a Log Analytics workspace for the use case.',
        a.isPrivate ? (a.hubId ? 'Peer the spoke VNet to the existing hub.' : 'Create a standalone VNet; no hub was found.') : null,
        a.isPrivate ? `Reuse ${a.reuseZones.length} private DNS zone(s) and create ${a.createZones.length}.` : null,
      ].filter(Boolean).join(' '),
      'Reuse keeps networking and monitoring consistent across use cases; changes to shared resources need the platform team.'),
    adr('ADR-05', 'Retrieval index sizing', `AI Search ${s.searchTier}, ${s.searchReplicas} replica(s) x ${s.searchPartitions} partition(s)`,
      `${s.documentGb} GB of documents is about ${fmt(s.chunks)} chunks and a ${s.indexGb} GB index (${s.vectorGb} GB of vectors). Environment: ${a.uc.environment}; availability target: ${a.uc.constraints.availability ?? 'not given'}%.`,
      `Use the ${s.searchTier} tier with ${s.searchPartitions} partition(s) for size and ${s.searchReplicas} replica(s)${a.uc.environment === 'prod' ? ' for the availability target' : ' (non-production)'}.`,
      'Re-check sizing after the first full index; partitions and replicas can be added without downtime.'),
    adr('ADR-06', 'Hosting and identity', 'Container Apps with a user-assigned managed identity',
      'The assistant API must call the model, search, storage and Key Vault.',
      'Host the API on Azure Container Apps and give it one user-assigned managed identity with role assignments on each service; local keys are disabled.',
      'No secrets to rotate for Azure services; role assignments are created in Phase 4.'),
    adr('ADR-07', 'AI gateway', a.apiGateway ? 'API Management in front of the assistant' : 'No gateway',
      `Users are ${a.uc.users.type}. ${a.options.apiGateway === null ? 'The rules decide unless the architect sets it.' : 'Set by the architect.'}`,
      a.apiGateway ? 'Put API Management in front of the API for token validation, rate and token limits and usage metrics per consumer.' : 'Expose the assistant API directly; Entra ID authentication is enforced in the app.',
      a.apiGateway ? 'Adds a monthly fixed cost and one more hop; gives central control as more use cases are added.' : 'Lower cost; add the gateway when the API is shared with other consumers or external users.'),
    adr('ADR-08', 'Chat history', a.chatHistory ? 'Cosmos DB serverless' : 'Not stored',
      'Multi-turn conversations need earlier turns; audit may need transcripts.',
      a.chatHistory ? 'Store conversations in Cosmos DB (serverless) with access through the managed identity.' : 'Do not store conversations; each question carries its own context.',
      a.chatHistory ? 'Transcripts are personal data when users ask about themselves - set a retention period.' : 'No follow-up questions across sessions and no transcript audit.'),
  ];
  if (a.teams) {
    out.push(adr('ADR-09', 'Microsoft Teams channel', 'Azure Bot with the Teams channel',
      'Teams is one of the user channels.',
      `Register an Azure Bot using the managed identity and connect the Teams channel to ${a.apiGateway ? 'the gateway' : 'the assistant API'}.`,
      'The Teams app package must be approved by the Teams administrator.'));
  }
  return out;
}

function summarise(uc: UseCaseSpec, region: string, isPrivate: boolean, components: ArchitectureComponent[], s: ArchitectureSizing, cost: CostEstimate): string {
  const created = components.filter((c) => !c.reuseExisting).length;
  const reused = components.length - created;
  return [
    `${uc.name} is a RAG knowledge assistant in ${region} (${uc.environment}).`,
    `Questions reach an API on Container Apps, which retrieves passages from Azure AI Search and answers with ${s.deploymentSku === 'ProvisionedManaged' ? 'provisioned' : 'pay-as-you-go'} Azure OpenAI models.`,
    isPrivate ? 'All data and model services are private, reached only through private endpoints.' : 'Services use public endpoints secured by Entra ID.',
    `The design has ${components.length} components (${created} new, ${reused} reused) and is estimated at about ${money(cost.monthlyUsd)} a month.`,
  ].join(' ');
}

/** Internal consistency (spec 4.4 acceptance): the diagram can draw exactly the spec. */
export function validateArchitecture(spec: ArchitectureSpec, allowedRegions: string[]): string[] {
  const problems: string[] = [];
  const ids = spec.components.map((c) => c.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`duplicate component ids: ${dup.join(', ')}`);
  for (const c of spec.connections) if (!ids.includes(c.from) || !ids.includes(c.to)) problems.push(`connection ${c.from} -> ${c.to} references a missing component`);
  for (const c of spec.components) if (!ZONES.some((z) => z.id === c.zone)) problems.push(`component ${c.id} has unknown zone ${c.zone}`);
  for (const l of spec.cost.lineItems) if (!ids.includes(l.component)) problems.push(`cost line ${l.item} references a missing component`);
  for (const id of ids) if (!spec.cost.lineItems.some((l) => l.component === id)) problems.push(`component ${id} has no cost line`);
  if (allowedRegions.length && !allowedRegions.map(lower).includes(spec.region)) problems.push(`region ${spec.region} is not allowed by policy`);
  if (spec.private) for (const c of spec.components) if (c.params.publicNetworkAccess === 'Enabled') problems.push(`${c.id} allows public access in a private design`);
  for (const t of MANDATORY_TAGS) if (!(t in spec.tags)) problems.push(`mandatory tag ${t} missing`);
  return problems;
}
