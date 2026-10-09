/**
 * Azure AI Factory Builder - Phase 5 (Validate & approve) core.
 *
 * Proves a deployment is safe before a person approves it (spec 4.6):
 * - a what-if: either the offline plan (what this bundle would create, from the
 *   design) or a real ARM what-if pasted from `az deployment group what-if`,
 *   parsed into Create / Modify / Delete / NoChange changes;
 * - rules that block approval (a delete of something this use case does not
 *   own, a region the policy disallows, public access in a private design, a
 *   what-if that does not match the bundle or the connected target, inputs
 *   still blank) and risks the approver must see;
 * - the bundle hash every approval is bound to.
 * Pure - no I/O.
 */
import { createHash } from 'crypto';
import { ArchitectureSpec } from './architecture';
import { IacFile, TargetEnv } from './iac-bundle';
import { InputName } from './iac-inputs';
import { RiskClass } from './use-case-spec';

export type ChangeType = 'Create' | 'Modify' | 'Delete' | 'NoChange' | 'Ignore' | 'Deploy' | 'Unsupported';
export type WhatIfSource = 'planned' | 'arm';

export interface WhatIfChange {
  resourceId: string;
  type: string;
  name: string;
  changeType: ChangeType;
  /** Created by this deployment, or tagged with this use case's ID (or a child of such a resource). */
  owned: boolean;
  location: string | null;
  propertyChanges: number;
  note: string | null;
  /** From an ARM what-if: the resource's tags and public network access after the deployment. */
  tags?: Record<string, string> | null;
  publicNetworkAccess?: string | null;
}

export interface WhatIfAssessment {
  blocking: string[];
  risks: string[];
  counts: Record<ChangeType, number>;
}

export interface RaiItem { id: string; text: string }

/** Spec 12: a responsible-AI checklist is required to approve a high-risk use case. */
export const RAI_CHECKLIST: RaiItem[] = [
  { id: 'content-safety', text: 'Content Safety filters are on for every model deployment and their thresholds were reviewed.' },
  { id: 'data-review', text: 'The data sources were reviewed for personal and regulated data, and access follows least privilege.' },
  { id: 'human-oversight', text: 'Answers that affect people (HR, finance, legal decisions) are reviewed by a person; the assistant does not decide.' },
  { id: 'transparency', text: 'Users are told they are using AI and can see the sources behind each answer.' },
  { id: 'evaluation', text: 'Groundedness and safety were evaluated on a test set before release.' },
  { id: 'incident', text: 'There is a way to report harmful answers, and an owner who acts on reports.' },
];

export interface ValidationReport {
  environment: TargetEnv;
  iacVersion: number;
  iacHash: string;
  architectureVersion: number;
  useCaseVersion: number;
  source: WhatIfSource;
  /** For an ARM what-if: pasted by the user, or run by the server with the user's Azure sign-in. Only a live one can back a deployment from the app. */
  armOrigin?: 'pasted' | 'live';
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

/** SHA-256 over the files in path order - what an approval is bound to (spec 4.6). */
export function bundleHash(files: IacFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\0${f.content}\0`);
  return h.digest('hex');
}

const lower = (s: string) => s.toLowerCase();
const zeroCounts = (): Record<ChangeType, number> => ({ Create: 0, Modify: 0, Delete: 0, NoChange: 0, Ignore: 0, Deploy: 0, Unsupported: 0 });

/** Resource type and name from an ARM ID: .../providers/Microsoft.X/a/n1/b/n2 -> Microsoft.X/a/b, n1/n2. */
export function parseResourceId(id: string): { type: string; name: string; scope: string } {
  const i = id.toLowerCase().lastIndexOf('/providers/');
  if (i < 0) return { type: 'unknown', name: id.split('/').pop() ?? id, scope: id };
  const parts = id.slice(i + '/providers/'.length).split('/');
  const ns = parts[0];
  const types: string[] = [];
  const names: string[] = [];
  for (let k = 1; k < parts.length; k += 2) { types.push(parts[k]); if (parts[k + 1] !== undefined) names.push(parts[k + 1]); }
  return { type: [ns, ...types].join('/'), name: names.join('/'), scope: id.slice(0, i) };
}

const MANDATORY_TAGS = ['useCaseId', 'owner', 'costCenter', 'environment', 'createdBy'];
/** Top-level resources that can carry tags (children, role assignments and diagnostics cannot). */
const taggable = (type: string) => type.split('/').length === 2 && !type.toLowerCase().startsWith('microsoft.authorization/') && !type.toLowerCase().startsWith('microsoft.insights/diagnosticsettings');

export interface PlanContext {
  spec: ArchitectureSpec;
  env: TargetEnv;
  workload: string;
  regionAbbreviation: string;
  subscriptionId: string;
  resourceGroup: string;
  useCaseId: string;
  /** Names already present in the subscription (Discover), to flag collisions. */
  existingNames: string[];
}

/**
 * The offline plan: what this bundle creates for one environment, with the names
 * the template computes. `xxxx` stands for the 4-character uniqueString() suffix,
 * which ARM computes from the resource group at deployment time.
 */
export function planWhatIf(ctx: PlanContext): WhatIfChange[] {
  const { spec, env } = ctx;
  const suffix = `${ctx.workload}-${env}-${ctx.regionAbbreviation}-001`;
  const u = 'xxxx';
  const rg = `/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}`;
  const has = (id: string) => spec.components.some((c) => c.id === id);
  const comp = (id: string) => spec.components.find((c) => c.id === id);
  const out: WhatIfChange[] = [];
  const create = (type: string, name: string, location: string | null = spec.region, note: string | null = null) =>
    out.push({ resourceId: `${rg}/providers/${type.split('/')[0]}/${type.split('/').slice(1).map((t, i) => `${t}/${name.split('/')[i]}`).join('/')}`, type, name, changeType: 'Create', owned: true, location, propertyChanges: 0, note });
  const referenced = (id: string, note: string) => {
    const { type, name } = parseResourceId(id);
    out.push({ resourceId: id, type, name, changeType: 'NoChange', owned: false, location: null, propertyChanges: 0, note });
  };

  const names = {
    identity: `id-${suffix}`,
    openAi: `oai-${suffix}-${u}`,
    search: `srch-${suffix}-${u}`,
    storage: `st${ctx.workload}${env}${ctx.regionAbbreviation}${u}`.toLowerCase().slice(0, 24),
    keyVault: `kv-${ctx.workload}-${env}-${u}`.slice(0, 24),
    containerEnv: `cae-${suffix}`,
    containerApp: `ca-${suffix}`.slice(0, 32),
    appInsights: `appi-${suffix}`,
    logAnalytics: `log-${suffix}`,
    vnet: `vnet-${suffix}`,
    cosmos: `cosmos-${suffix}-${u}`,
    apim: `apim-${suffix}-${u}`,
    bot: `bot-${suffix}`,
  };

  create('Microsoft.ManagedIdentity/userAssignedIdentities', names.identity);
  const la = comp('log-analytics');
  if (la?.reuseExisting && la.resourceId) referenced(la.resourceId, 'Existing workspace - receives diagnostics, not changed.');
  else create('Microsoft.OperationalInsights/workspaces', names.logAnalytics);
  create('Microsoft.Insights/components', names.appInsights);
  if (spec.private) {
    create('Microsoft.Network/virtualNetworks', names.vnet);
    const hub = comp('hub-vnet');
    if (hub?.resourceId) {
      create('Microsoft.Network/virtualNetworks/virtualNetworkPeerings', `${names.vnet}/${names.vnet}-${parseResourceId(hub.resourceId).name}`, null, 'Spoke side of the hub peering.');
      referenced(hub.resourceId, 'Existing hub - the platform team adds the hub-side peering.');
    }
    const dns = (comp('private-dns')?.params ?? { reuse: [], create: [] }) as { reuse: string[]; create: string[] };
    for (const z of dns.create) create('Microsoft.Network/privateDnsZones', z, 'global');
    for (const z of dns.reuse) out.push({ resourceId: `<privateDnsZoneResourceGroupId>/providers/Microsoft.Network/privateDnsZones/${z}`, type: 'Microsoft.Network/privateDnsZones', name: z, changeType: 'NoChange', owned: false, location: 'global', propertyChanges: 0, note: 'Shared zone - private endpoints register their addresses in it.' });
  }
  create('Microsoft.CognitiveServices/accounts', names.openAi);
  create('Microsoft.CognitiveServices/accounts/deployments', `${names.openAi}/chat`, null);
  create('Microsoft.CognitiveServices/accounts/deployments', `${names.openAi}/embedding`, null);
  create('Microsoft.Storage/storageAccounts', names.storage);
  create('Microsoft.Search/searchServices', names.search);
  create('Microsoft.KeyVault/vaults', names.keyVault);
  if (has('cosmos')) create('Microsoft.DocumentDB/databaseAccounts', names.cosmos);
  create('Microsoft.App/managedEnvironments', names.containerEnv);
  create('Microsoft.App/containerApps', names.containerApp);
  if (has('apim')) create('Microsoft.ApiManagement/service', names.apim);
  if (has('bot')) create('Microsoft.BotService/botServices', names.bot, 'global');
  const peTargets = ((comp('private-endpoints')?.params.targets as string[] | undefined) ?? []).filter((t) => has(t));
  if (spec.private) {
    // AVM's default endpoint name: pep-<resource>-<service>-<index>
    const target: Record<string, [string, string]> = { aoai: [names.openAi, 'account'], search: [names.search, 'searchService'], storage: [names.storage, 'blob'], keyvault: [names.keyVault, 'vault'], cosmos: [names.cosmos, 'Sql'] };
    for (const t of peTargets) create('Microsoft.Network/privateEndpoints', `pep-${target[t][0]}-${target[t][1]}-0`, spec.region, 'With a DNS zone group.');
  }
  const roleCount = 6 + (has('cosmos') ? 1 : 0);
  out.push({ resourceId: `${rg}/providers/Microsoft.Authorization/roleAssignments/(${roleCount})`, type: 'Microsoft.Authorization/roleAssignments', name: `${roleCount} role assignments for ${names.identity}`, changeType: 'Create', owned: true, location: null, propertyChanges: 0, note: 'RBAC instead of keys.' });

  const existing = new Set(ctx.existingNames.map(lower));
  for (const c of out) if (c.changeType === 'Create' && existing.has(lower(c.name.split('/')[0]))) c.note = `${c.note ? `${c.note} ` : ''}A resource with this name already exists in the subscription.`;
  return out;
}

export interface ArmWhatIfResult { status: 'succeeded' | 'failed'; error: string | null; changes: WhatIfChange[]; problems: string[] }

/**
 * Reads `az deployment group what-if --no-pretty-print` output (or the REST
 * response with `properties.changes`). Ownership: created here, tagged with
 * this use case, or a child of an owned resource.
 */
export function parseArmWhatIf(raw: string, useCaseId: string): ArmWhatIfResult {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: 'failed', error: null, changes: [], problems: ['The what-if output is not valid JSON - run the command with --no-pretty-print and paste all of it.'] };
  }
  const changesRaw = Array.isArray(data?.changes) ? data.changes : Array.isArray(data?.properties?.changes) ? data.properties.changes : null;
  const err = data?.error ?? data?.properties?.error ?? null;
  const status = String(data?.status ?? (err ? 'Failed' : 'Succeeded'));
  if (!changesRaw) {
    return { status: 'failed', error: err ? String(err.message ?? JSON.stringify(err)) : null, changes: [], problems: err ? [] : ['No "changes" list was found - paste the full what-if output.'] };
  }
  const changes: WhatIfChange[] = [];
  const problems: string[] = [];
  for (const c of changesRaw) {
    if (typeof c?.resourceId !== 'string' || typeof c?.changeType !== 'string') { problems.push('A change without resourceId or changeType was skipped.'); continue; }
    const { type, name } = parseResourceId(c.resourceId);
    const state = c.after ?? c.before ?? {};
    const ownTags = (c.after?.tags ?? c.before?.tags ?? {}) as Record<string, string>;
    changes.push({
      resourceId: c.resourceId,
      type,
      name,
      changeType: (['Create', 'Modify', 'Delete', 'NoChange', 'Ignore', 'Deploy', 'Unsupported'].includes(c.changeType) ? c.changeType : 'Unsupported') as ChangeType,
      owned: c.changeType === 'Create' || ownTags.useCaseId === useCaseId,
      location: typeof state.location === 'string' ? state.location : null,
      propertyChanges: Array.isArray(c.delta) ? c.delta.length : 0,
      note: null,
      tags: c.after?.tags ?? null,
      publicNetworkAccess: typeof c.after?.properties?.publicNetworkAccess === 'string' ? c.after.properties.publicNetworkAccess : null,
    });
  }
  // Children (deployments, role assignments, private endpoint DNS groups) belong to their owned parent.
  const ownedIds = changes.filter((c) => c.owned).map((c) => lower(c.resourceId));
  for (const c of changes) if (!c.owned && ownedIds.some((p) => lower(c.resourceId).startsWith(`${p}/`))) c.owned = true;
  return { status: /^succeeded$/i.test(status) && !err ? 'succeeded' : 'failed', error: err ? String(err.message ?? JSON.stringify(err)) : null, changes, problems };
}

export interface AssessContext {
  spec: ArchitectureSpec;
  source: WhatIfSource;
  allowedLocations: string[];
  useCaseId: string;
  /** The connected target - an ARM what-if must have been run against it. */
  subscriptionId: string;
  resourceGroup: string;
  /** The offline plan, to check an ARM what-if is for this bundle. */
  plan: WhatIfChange[];
  armStatus?: 'succeeded' | 'failed';
  armError?: string | null;
  armProblems?: string[];
}

/** What blocks approval and what the approver must weigh (spec 4.6). */
export function assessWhatIf(changes: WhatIfChange[], ctx: AssessContext): WhatIfAssessment {
  const blocking: string[] = [];
  const risks: string[] = [];
  const counts = zeroCounts();
  for (const c of changes) counts[c.changeType]++;
  const allowed = ctx.allowedLocations.map(lower);
  const show = (c: WhatIfChange) => `${c.type.split('/').pop()} ${c.name}`;

  if (ctx.source === 'arm') {
    if (ctx.armStatus !== 'succeeded') blocking.push(`The what-if did not succeed${ctx.armError ? `: ${ctx.armError}` : ''}.`);
    for (const p of ctx.armProblems ?? []) risks.push(p);
    const target = lower(`/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}/`);
    const elsewhere = changes.filter((c) => c.changeType === 'Create' && !lower(c.resourceId).startsWith(target));
    if (elsewhere.length) blocking.push(`The what-if creates resources outside the connected target (${ctx.subscriptionId} / ${ctx.resourceGroup}), e.g. ${elsewhere[0].resourceId} - run it against the connected resource group.`);
    // Is this the what-if of this bundle? Every planned top-level resource must appear (xxxx = uniqueString suffix).
    const planned = ctx.plan.filter((p) => p.changeType === 'Create' && taggable(p.type));
    const seen = changes.map((c) => `${lower(c.type)}|${lower(c.name)}`);
    const missing = planned.filter((p) => {
      const re = new RegExp(`^${lower(p.type).replace(/[.]/g, '\\.')}\\|${lower(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/xxxx/g, '[a-z0-9]{4}')}$`);
      return !seen.some((s) => re.test(s));
    });
    if (missing.length) blocking.push(`This what-if does not match the bundle: ${missing.length} planned resource(s) are missing, e.g. ${show(missing[0])}. Run it with this bundle's files and the selected environment's parameter file.`);
    for (const c of changes.filter((x) => x.changeType === 'Create' && taggable(x.type))) {
      const tags = c.tags ?? {};
      const absent = MANDATORY_TAGS.filter((t) => !tags[t]);
      if (absent.length) risks.push(`${show(c)} is created without the tag(s) ${absent.join(', ')}.`);
      if (ctx.spec.private && c.publicNetworkAccess?.toLowerCase() === 'enabled') blocking.push(`${show(c)} would allow public network access, but the design is private.`);
    }
    if (counts.Unsupported) risks.push(`${counts.Unsupported} change(s) could not be evaluated by what-if (Unsupported) - review them by hand.`);
  }

  for (const c of changes) {
    if (c.changeType === 'Delete' && !c.owned) blocking.push(`${show(c)} would be deleted, and it does not belong to this use case.`);
    if (c.changeType === 'Delete' && c.owned) risks.push(`${show(c)} (this use case's) would be deleted.`);
    if (c.changeType === 'Modify' && !c.owned) risks.push(`${show(c)} is shared and would be modified (${c.propertyChanges} propert${c.propertyChanges === 1 ? 'y' : 'ies'}).`);
    if ((c.changeType === 'Create' || c.changeType === 'Modify') && c.location && allowed.length && !['global'].includes(lower(c.location)) && !allowed.includes(lower(c.location).replace(/\s+/g, ''))) {
      blocking.push(`${show(c)} would be placed in ${c.location}, which the policy does not allow (${allowed.join(', ')}).`);
    }
    if (c.note?.includes('already exists')) risks.push(`${show(c)}: a resource with this name already exists in the subscription.`);
  }
  return { blocking: [...new Set(blocking)], risks: [...new Set(risks)], counts };
}
