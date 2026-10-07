/**
 * Azure AI Factory Builder - Phase 1 (Discover) core.
 *
 * Builds the Environment Profile (spec 6.3) for a target subscription and
 * derives the constraints every later design choice must respect: allowed
 * regions, private-endpoint mandates, required tags, what to reuse (hub VNet,
 * Log Analytics, private DNS zones) and model-quota headroom.
 *
 * Offline-first: the profile comes from a form, from pasted Azure Resource
 * Graph output (the queries in `discovery-queries.ts`), or from a sample. The
 * live wave will fill the same shape from Resource Graph directly. Pure and
 * deterministic - no I/O - so it is fully unit-testable.
 */

export interface VnetSummary { id: string; name: string; location: string; addressPrefixes: string[] }
export interface WorkspaceSummary { id: string; name: string; location: string }
export interface AiAccountSummary { id: string; name: string; location: string; kind: string; sku: string; publicNetworkAccess: string | null }
export interface ModelQuota { region: string; model: string; sku: string; limitTpm: number; usedTpm: number }

export interface EnvironmentProfile {
  subscriptionId: string;
  scannedAt: string;
  network: { vnets: VnetSummary[]; hubVnetId: string | null; privateDnsZones: string[] };
  monitoring: { workspaces: WorkspaceSummary[]; logAnalyticsId: string | null };
  security: { keyVaults: string[]; secureScore: number | null };
  ai: { existingAccounts: AiAccountSummary[]; modelQuota: ModelQuota[] };
  policy: { allowedLocations: string[]; requiredTags: string[]; denyPublicNetworkAccess: boolean; deniedSkus: string[] };
  resourceCount: number;
}

/** What the target environment forces on the design (Phase 3 reads this). */
export interface EnvironmentConstraints {
  targetRegion: string | null;
  /** null when no allowed-locations policy is in force. */
  targetRegionAllowed: boolean | null;
  allowedRegions: string[];
  privateEndpointsRequired: boolean;
  requiredTags: string[];
  reuse: Array<{ component: string; resourceId: string; reason: string }>;
  /** Private DNS zones the RAG pattern needs for private endpoints but the subscription does not have. */
  missingPrivateDnsZones: string[];
  modelQuota: Array<ModelQuota & { headroomTpm: number; headroomPercent: number }>;
  warnings: string[];
}

/** Private DNS zones the RAG assistant pattern needs when its services sit behind private endpoints. */
export const RAG_PRIVATE_DNS_ZONES = [
  'privatelink.openai.azure.com',
  'privatelink.cognitiveservices.azure.com',
  'privatelink.search.windows.net',
  'privatelink.blob.core.windows.net',
  'privatelink.vaultcore.azure.net',
];

/** Below this share of free model quota in the target region, warn. */
const LOW_QUOTA_HEADROOM_PERCENT = 20;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : []);
const lower = (s: string) => s.trim().toLowerCase();
const region = (s: unknown) => lower(str(s)).replace(/\s+/g, '');

/**
 * Accepts Resource Graph output as pasted from the Azure portal (Resource Graph
 * Explorer -> download / copy), `az graph query -o json` ({ data: [...] }), or a
 * bare array of rows. Returns the rows and anything that could not be read.
 */
export function readResourceGraphRows(raw: unknown): { rows: Array<Record<string, unknown>>; problems: string[] } {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { rows: [], problems: ['The pasted Resource Graph output is not valid JSON.'] };
    }
  }
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : null;
  if (!rows) return { rows: [], problems: ['Expected an array of Resource Graph rows, or an object with a "data" array.'] };
  const valid = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { type?: unknown }).type === 'string');
  const problems = valid.length < rows.length ? [`${rows.length - valid.length} row(s) had no "type" and were skipped.`] : [];
  return { rows: valid, problems };
}

/** Inputs from the Discover form; the parts Resource Graph rows cannot supply (policy, quota, secure score). */
export interface ProfileFormInput {
  hubVnetId?: string | null;
  logAnalyticsId?: string | null;
  privateDnsZones?: string[];
  keyVaults?: string[];
  secureScore?: number | null;
  allowedLocations?: string[];
  requiredTags?: string[];
  denyPublicNetworkAccess?: boolean;
  deniedSkus?: string[];
  modelQuota?: Array<Partial<ModelQuota>>;
}

/**
 * Builds a profile from optional Resource Graph rows plus form input. Form
 * values win where both give the same thing (e.g. an explicit hub VNet).
 */
export function buildEnvironmentProfile(
  subscriptionId: string,
  rows: Array<Record<string, unknown>>,
  form: ProfileFormInput,
  scannedAt: string,
): EnvironmentProfile {
  const ofType = (t: string) => rows.filter((r) => lower(str(r.type)) === t);
  const vnets: VnetSummary[] = ofType('microsoft.network/virtualnetworks').map((r) => ({
    id: str(r.id), name: str(r.name), location: region(r.location),
    addressPrefixes: strList(r.addressSpace ?? (r.properties as any)?.addressSpace?.addressPrefixes),
  }));
  const workspaces: WorkspaceSummary[] = ofType('microsoft.operationalinsights/workspaces').map((r) => ({ id: str(r.id), name: str(r.name), location: region(r.location) }));
  const aiAccounts: AiAccountSummary[] = ofType('microsoft.cognitiveservices/accounts').map((r) => ({
    id: str(r.id), name: str(r.name), location: region(r.location), kind: str(r.kind),
    sku: str(r.sku && typeof r.sku === 'object' ? (r.sku as any).name : r.sku),
    publicNetworkAccess: r.publicAccess != null ? str(r.publicAccess) : (r.properties as any)?.publicNetworkAccess != null ? str((r.properties as any).publicNetworkAccess) : null,
  }));
  const dnsZones = ofType('microsoft.network/privatednszones').map((r) => lower(str(r.name)));
  const keyVaults = ofType('microsoft.keyvault/vaults').map((r) => str(r.id));

  // A hub VNet is the one named like a hub; with no clear hub, leave it for the architect to pick.
  const namedHub = vnets.find((v) => /(^|[-_])hub([-_]|$)/i.test(v.name));
  const uniq = (xs: string[]) => [...new Set(xs)];

  return {
    subscriptionId,
    scannedAt,
    network: {
      vnets,
      hubVnetId: form.hubVnetId?.trim() || namedHub?.id || null,
      privateDnsZones: uniq([...dnsZones, ...(form.privateDnsZones ?? []).map(lower)]).sort(),
    },
    monitoring: { workspaces, logAnalyticsId: form.logAnalyticsId?.trim() || (workspaces.length === 1 ? workspaces[0].id : null) },
    security: { keyVaults: uniq([...keyVaults, ...(form.keyVaults ?? [])]), secureScore: form.secureScore ?? null },
    ai: {
      existingAccounts: aiAccounts,
      modelQuota: (form.modelQuota ?? []).map((q) => ({
        region: region(q.region), model: str(q.model).trim(), sku: str(q.sku).trim() || 'Standard',
        limitTpm: Number(q.limitTpm) || 0, usedTpm: Number(q.usedTpm) || 0,
      })),
    },
    policy: {
      allowedLocations: uniq((form.allowedLocations ?? []).map(region).filter(Boolean)),
      requiredTags: uniq((form.requiredTags ?? []).map((t) => t.trim()).filter(Boolean)),
      denyPublicNetworkAccess: !!form.denyPublicNetworkAccess,
      deniedSkus: uniq((form.deniedSkus ?? []).map((s) => s.trim()).filter(Boolean)),
    },
    resourceCount: rows.length,
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns human-readable problems; an empty list means the profile is valid. */
export function validateEnvironmentProfile(p: EnvironmentProfile): string[] {
  const errors: string[] = [];
  if (!GUID.test(p.subscriptionId)) errors.push('subscriptionId must be a subscription GUID.');
  if (Number.isNaN(Date.parse(p.scannedAt))) errors.push('scannedAt must be an ISO date-time.');
  if (p.security.secureScore != null && (p.security.secureScore < 0 || p.security.secureScore > 100)) errors.push('secureScore must be between 0 and 100.');
  for (const [i, q] of p.ai.modelQuota.entries()) {
    if (!q.region || !q.model) errors.push(`Model quota row ${i + 1} needs a region and a model.`);
    if (q.limitTpm < 0 || q.usedTpm < 0) errors.push(`Model quota row ${i + 1}: tokens per minute cannot be negative.`);
    if (q.usedTpm > q.limitTpm) errors.push(`Model quota row ${i + 1}: used TPM (${q.usedTpm}) is above the limit (${q.limitTpm}).`);
  }
  const idLike = (s: string) => s.startsWith('/subscriptions/');
  if (p.network.hubVnetId && !idLike(p.network.hubVnetId)) errors.push('hubVnetId must be an Azure resource ID (/subscriptions/...).');
  if (p.monitoring.logAnalyticsId && !idLike(p.monitoring.logAnalyticsId)) errors.push('logAnalyticsId must be an Azure resource ID (/subscriptions/...).');
  return errors;
}

/** Derives what the design must respect in this environment for a target region. */
export function deriveConstraints(p: EnvironmentProfile, targetRegion: string | null): EnvironmentConstraints {
  const target = targetRegion ? region(targetRegion) : null;
  const allowed = p.policy.allowedLocations;
  const warnings: string[] = [];
  const targetRegionAllowed = allowed.length === 0 || !target ? null : allowed.includes(target);
  if (targetRegionAllowed === false) warnings.push(`Target region ${target} is not in the allowed locations (${allowed.join(', ')}) - pick an allowed region before Phase 3.`);

  const reuse: EnvironmentConstraints['reuse'] = [];
  if (p.network.hubVnetId) reuse.push({ component: 'hub-vnet', resourceId: p.network.hubVnetId, reason: 'Peer the use-case spoke to the existing hub instead of creating parallel networking.' });
  if (p.monitoring.logAnalyticsId) reuse.push({ component: 'log-analytics', resourceId: p.monitoring.logAnalyticsId, reason: 'Send diagnostics to the existing workspace.' });
  else if (p.monitoring.workspaces.length > 1) warnings.push(`${p.monitoring.workspaces.length} Log Analytics workspaces found - choose which one diagnostics should go to.`);
  if (p.security.keyVaults.length) reuse.push({ component: 'key-vault', resourceId: p.security.keyVaults[0], reason: 'A Key Vault already exists; a dedicated use-case vault is still created, but secrets policy can follow this one.' });

  const privateEndpointsRequired = p.policy.denyPublicNetworkAccess;
  const missingPrivateDnsZones = privateEndpointsRequired ? RAG_PRIVATE_DNS_ZONES.filter((z) => !p.network.privateDnsZones.includes(z)) : [];
  if (missingPrivateDnsZones.length) warnings.push(`Public network access is denied by policy, but ${missingPrivateDnsZones.length} private DNS zone(s) the RAG pattern needs are missing: ${missingPrivateDnsZones.join(', ')}. They will be created or must be provided by the hub team.`);
  if (privateEndpointsRequired && !p.network.hubVnetId && p.network.vnets.length === 0) warnings.push('Private endpoints are required but no VNet was found - the design will create one.');

  const quotaRows = p.ai.modelQuota.filter((q) => !target || q.region === target).map((q) => {
    const headroomTpm = Math.max(0, q.limitTpm - q.usedTpm);
    return { ...q, headroomTpm, headroomPercent: q.limitTpm > 0 ? Math.round((headroomTpm / q.limitTpm) * 100) : 0 };
  });
  for (const q of quotaRows) if (q.headroomPercent < LOW_QUOTA_HEADROOM_PERCENT) warnings.push(`Only ${q.headroomPercent}% of ${q.model} (${q.sku}) quota is free in ${q.region} - request more or consider provisioned throughput.`);
  if (target && p.ai.modelQuota.length > 0 && quotaRows.length === 0) warnings.push(`No model quota is recorded for the target region ${target}.`);
  if (p.security.secureScore != null && p.security.secureScore < 50) warnings.push(`Defender for Cloud secure score is ${p.security.secureScore} - review open recommendations before deploying.`);

  return {
    targetRegion: target,
    targetRegionAllowed,
    allowedRegions: allowed,
    privateEndpointsRequired,
    requiredTags: p.policy.requiredTags,
    reuse,
    missingPrivateDnsZones,
    modelQuota: quotaRows,
    warnings,
  };
}
