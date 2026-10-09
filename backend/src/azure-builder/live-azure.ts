import { ArmClient, ArmError } from './arm-client';
import { AzureRole } from './azure-builder.enums';
import { DISCOVERY_QUERIES } from './discovery-queries';
import { ModelQuota, ProfileFormInput } from './environment-profile';

/**
 * Azure AI Factory Builder - live Phases 0 (Connect) and 1 (Discover), Wave 6.
 * Reads the subscription with the user's own delegated ARM token: the user can
 * only see and do what their Azure role allows. Pure mapping functions are
 * exported for tests; the ARM calls are the thin functions at the bottom.
 */

const API = {
  subscriptions: '2022-12-01',
  resourceGroups: '2021-04-01',
  permissions: '2022-04-01',
  policyAssignments: '2023-04-01',
  resourceGraph: '2022-10-01',
  cognitiveUsages: '2023-05-01',
  secureScore: '2020-01-01',
};

// ---- Permissions (Microsoft.Authorization/permissions) ----

export interface ArmPermission {
  actions?: string[];
  notActions?: string[];
}

export interface EffectivePermissions {
  scope: string;
  canRead: boolean;
  /** Can create deployments and resources (Contributor or above). */
  canWrite: boolean;
  /** Can create role assignments - the RAG bundle grants its managed identities access to Search, OpenAI and Storage. */
  canAssignRoles: boolean;
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`, 'i');
}

/** True when some permission grants `action` and does not exclude it (ARM's own evaluation, without deny assignments). */
export function actionAllowed(permissions: ArmPermission[], action: string): boolean {
  return permissions.some((p) => (p.actions ?? []).some((a) => wildcard(a).test(action)) && !(p.notActions ?? []).some((n) => wildcard(n).test(action)));
}

export function effectivePermissions(scope: string, permissions: ArmPermission[]): EffectivePermissions {
  return {
    scope,
    canRead: actionAllowed(permissions, 'Microsoft.Resources/subscriptions/resourceGroups/read'),
    canWrite: actionAllowed(permissions, 'Microsoft.Resources/deployments/write'),
    canAssignRoles: actionAllowed(permissions, 'Microsoft.Authorization/roleAssignments/write'),
  };
}

/** Owner here means "can deploy and assign roles" (Owner, or Contributor plus a role-assignment role). */
export function roleFromPermissions(p: EffectivePermissions): AzureRole {
  if (p.canWrite && p.canAssignRoles) return AzureRole.OWNER;
  if (p.canWrite) return AzureRole.CONTRIBUTOR;
  if (p.canRead) return AzureRole.READER;
  return AzureRole.UNKNOWN;
}

// ---- Policy (Microsoft.Authorization/policyAssignments) ----

export interface ArmPolicyAssignment {
  name?: string;
  properties?: {
    displayName?: string;
    policyDefinitionId?: string;
    enforcementMode?: string;
    parameters?: Record<string, { value?: unknown }>;
  };
}

/** Built-in policy definitions Discover reads (by GUID, the last segment of the definition ID). */
const POLICY = {
  allowedLocations: 'e56962a6-4747-49cd-b67b-bf8b01975c4c',
  allowedResourceGroupLocations: 'e765b5de-1225-4ba3-bd56-1ac6695af988',
  requireTagOnResources: '871b6d14-10aa-478d-b590-94f262ecfa99',
  requireTagOnResourceGroups: '96670d01-0a4d-4649-9c89-2d3abc0a5025',
  requireTagAndValueOnResources: '1e30110a-5ceb-460c-a204-c1c3969c6d62',
};

export interface PolicySummary {
  allowedLocations: string[];
  requiredTags: string[];
  denyPublicNetworkAccess: boolean;
  problems: string[];
}

/**
 * Summarises the policy effects the design must respect (spec 4.2) from the
 * assignments in force on the subscription, inherited ones included. Initiatives
 * (policy sets) are counted, not expanded - the architect checks them by hand.
 */
export function summarisePolicy(assignments: ArmPolicyAssignment[]): PolicySummary {
  const enforced = assignments.filter((a) => (a.properties?.enforcementMode ?? 'Default') !== 'DoNotEnforce');
  const definitionGuid = (a: ArmPolicyAssignment) => (a.properties?.policyDefinitionId ?? '').split('/').pop()?.toLowerCase() ?? '';
  const param = (a: ArmPolicyAssignment, name: string) => a.properties?.parameters?.[name]?.value;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
  const region = (s: string) => s.toLowerCase().replace(/\s+/g, '');

  const lists = (guid: string) => enforced.filter((a) => definitionGuid(a) === guid).map((a) => strings(param(a, 'listOfAllowedLocations')).map(region));
  // Every allowed-locations assignment must be satisfied at once, so the lists intersect.
  const locationLists = [...lists(POLICY.allowedLocations), ...lists(POLICY.allowedResourceGroupLocations)].filter((l) => l.length);
  const allowedLocations = locationLists.length ? locationLists.reduce((acc, l) => acc.filter((x) => l.includes(x))) : [];

  const tagGuids = new Set([POLICY.requireTagOnResources, POLICY.requireTagOnResourceGroups, POLICY.requireTagAndValueOnResources]);
  const requiredTags = [...new Set(enforced.filter((a) => tagGuids.has(definitionGuid(a))).flatMap((a) => strings(param(a, 'tagName'))))];

  const publicAccess = enforced.filter((a) => /public\s*network\s*access|disable\s*public|private\s*link/i.test(`${a.properties?.displayName ?? ''} ${a.name ?? ''}`));
  const denying = publicAccess.filter((a) => String(param(a, 'effect') ?? '').toLowerCase() === 'deny');
  const problems: string[] = [];
  if (publicAccess.length > denying.length) {
    problems.push(`${publicAccess.length - denying.length} public-network-access policy assignment(s) do not set the effect to Deny explicitly - check whether they deny or only audit.`);
  }
  const sets = enforced.filter((a) => /\/policySetDefinitions\//i.test(a.properties?.policyDefinitionId ?? ''));
  if (sets.length) problems.push(`${sets.length} policy initiative(s) are assigned (${sets.slice(0, 3).map((a) => a.properties?.displayName ?? a.name).join(', ')}${sets.length > 3 ? ', ...' : ''}); their policies were not expanded - check them for location, tag and SKU rules.`);
  return { allowedLocations, requiredTags, denyPublicNetworkAccess: denying.length > 0, problems };
}

// ---- Model quota (Microsoft.CognitiveServices usages) ----

export interface ArmUsage {
  name?: { value?: string };
  currentValue?: number;
  limit?: number;
}

/**
 * Azure OpenAI quota per model and deployment type for one region. Usage names
 * look like `OpenAI.Standard.gpt-4o`; one unit of capacity is 1,000 tokens per minute.
 */
export function quotaFromUsages(region: string, usages: ArmUsage[]): ModelQuota[] {
  return usages.flatMap((u) => {
    const [provider, sku, ...model] = (u.name?.value ?? '').split('.');
    if (provider !== 'OpenAI' || !sku || !model.length || !(Number(u.limit) > 0)) return [];
    return [{ region, model: model.join('.'), sku, limitTpm: Number(u.limit) * 1000, usedTpm: (Number(u.currentValue) || 0) * 1000 }];
  });
}

// ---- ARM calls ----

export interface LiveSubscription {
  subscriptionId: string;
  displayName: string;
  tenantId: string;
  state: string;
}

export async function listSubscriptions(arm: ArmClient): Promise<LiveSubscription[]> {
  const subs = await arm.list<{ subscriptionId: string; displayName: string; tenantId: string; state: string }>(`/subscriptions?api-version=${API.subscriptions}`);
  return subs.map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName, tenantId: s.tenantId, state: s.state })).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listResourceGroups(arm: ArmClient, subscriptionId: string): Promise<Array<{ name: string; location: string }>> {
  const groups = await arm.list<{ name: string; location: string }>(`/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups?api-version=${API.resourceGroups}`);
  return groups.map((g) => ({ name: g.name, location: g.location })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface VerifiedTarget {
  subscriptionName: string;
  tenantId: string;
  resourceGroupExists: boolean;
  resourceGroupLocation: string | null;
  regionKnown: boolean;
  permissions: EffectivePermissions;
  role: AzureRole;
}

/** Confirms the subscription, resource group and region exist for this user, and reads the effective permissions on the target scope. */
export async function verifyTarget(arm: ArmClient, subscriptionId: string, resourceGroup: string, region: string): Promise<VerifiedTarget> {
  const sub = `/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const subscription = await arm.get<{ displayName: string; tenantId: string }>(`${sub}?api-version=${API.subscriptions}`);
  const locations = await arm.list<{ name: string }>(`${sub}/locations?api-version=${API.subscriptions}`);
  let group: { location: string } | null = null;
  try {
    group = await arm.get<{ location: string }>(`${sub}/resourcegroups/${encodeURIComponent(resourceGroup)}?api-version=${API.resourceGroups}`);
  } catch (err) {
    if (!(err instanceof ArmError && err.status === 404)) throw err;
  }
  // A new resource group does not exist yet, so its permissions are the subscription's.
  const scopePath = group ? `${sub}/resourceGroups/${encodeURIComponent(resourceGroup)}` : sub;
  const perms = await arm.list<ArmPermission>(`${scopePath}/providers/Microsoft.Authorization/permissions?api-version=${API.permissions}`);
  const permissions = effectivePermissions(group ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` : `/subscriptions/${subscriptionId}`, perms);
  return {
    subscriptionName: subscription.displayName,
    tenantId: subscription.tenantId,
    resourceGroupExists: !!group,
    resourceGroupLocation: group?.location ?? null,
    regionKnown: locations.some((l) => l.name.toLowerCase() === region.toLowerCase()),
    permissions,
    role: roleFromPermissions(permissions),
  };
}

/** Runs a Resource Graph query over one subscription, following skip tokens up to `maxRows`. */
export async function resourceGraph(arm: ArmClient, subscriptionId: string, query: string, maxRows = 5000): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let skipToken: string | undefined;
  do {
    const page: { data?: Array<Record<string, unknown>>; $skipToken?: string } = await arm.post(`/providers/Microsoft.ResourceGraph/resources?api-version=${API.resourceGraph}`, {
      subscriptions: [subscriptionId],
      query,
      options: { $top: 1000, resultFormat: 'objectArray', ...(skipToken ? { $skipToken: skipToken } : {}) },
    });
    rows.push(...(page.data ?? []));
    skipToken = page.$skipToken;
  } while (skipToken && rows.length < maxRows);
  return rows.slice(0, maxRows);
}

export interface LiveDiscovery {
  rows: Array<Record<string, unknown>>;
  form: ProfileFormInput;
  problems: string[];
}

const describe = (what: string, err: unknown) =>
  err instanceof ArmError
    ? `${what} could not be read (${err.status === 403 ? 'no permission' : err.code}): ${err.message}`
    : `${what} could not be read: ${err instanceof Error ? err.message : String(err)}`;

/**
 * Builds the inputs for an Environment Profile from the live subscription:
 * Resource Graph rows plus policy, model quota and secure score. Any part the
 * user cannot read is reported in `problems`, not fatal (spec 4.2) - except
 * the Resource Graph query itself, without which there is no profile.
 */
export async function discoverLive(arm: ArmClient, subscriptionId: string, region: string): Promise<LiveDiscovery> {
  const sub = `/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const combined = DISCOVERY_QUERIES.find((q) => q.id === 'combined')!.query;
  const rows = await resourceGraph(arm, subscriptionId, combined);
  const problems: string[] = [];
  const form: ProfileFormInput = {};

  try {
    const assignments = await arm.list<ArmPolicyAssignment>(`${sub}/providers/Microsoft.Authorization/policyAssignments?api-version=${API.policyAssignments}&$filter=atScope()`);
    const policy = summarisePolicy(assignments);
    form.allowedLocations = policy.allowedLocations;
    form.requiredTags = policy.requiredTags;
    form.denyPublicNetworkAccess = policy.denyPublicNetworkAccess;
    problems.push(...policy.problems);
  } catch (err) {
    problems.push(describe('Policy assignments', err));
  }

  try {
    const usages = await arm.list<ArmUsage>(`${sub}/providers/Microsoft.CognitiveServices/locations/${encodeURIComponent(region)}/usages?api-version=${API.cognitiveUsages}`);
    form.modelQuota = quotaFromUsages(region, usages);
    if (!form.modelQuota.length) problems.push(`No Azure OpenAI quota was found in ${region} - request quota before deploying model endpoints there.`);
  } catch (err) {
    problems.push(describe(`Azure OpenAI quota in ${region}`, err));
  }

  try {
    const score = await arm.get<{ properties?: { score?: { percentage?: number } } }>(`${sub}/providers/Microsoft.Security/secureScores/ascScore?api-version=${API.secureScore}`);
    const pct = score.properties?.score?.percentage;
    if (typeof pct === 'number') form.secureScore = Math.round(pct * 100);
  } catch (err) {
    // Defender for Cloud is optional (spec 4.2); say so without the raw ARM error.
    problems.push(err instanceof ArmError && (err.status === 404 || err.status === 403) ? 'Defender for Cloud secure score is not available for this subscription or user.' : describe('Defender for Cloud secure score', err));
  }

  return { rows, form, problems };
}
