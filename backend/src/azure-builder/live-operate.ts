import { ArmClient, ArmError } from './arm-client';
import { resourceGraph } from './live-azure';
import { StackSummary } from './live-deploy';
import { WhatIfChange } from './validate-approve';

/**
 * Azure AI Factory Builder - Phase 7 (Operate), Wave 6c: smoke tests, a budget,
 * drift and teardown for a deployed Deployment Stack (spec 4.8). Everything runs
 * with the user's own sign-in for the request; pure checks are exported for tests.
 */

const API = { budgets: '2023-05-01', stacks: '2024-03-01', aiDeployments: '2024-10-01' };

export type CheckStatus = 'passed' | 'failed' | 'warning' | 'skipped';

export interface OperateCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Resources the check is about (failing ones first). */
  resources?: string[];
}

/** A row of the Resource Graph query over the stack's resources. */
export interface ResourceRow {
  id: string;
  name: string;
  type: string;
  provisioningState: string | null;
  publicNetworkAccess: string | null;
  latestRevisionName: string | null;
  latestReadyRevisionName: string | null;
  runningStatus: string | null;
}

/** Resource types whose public network access a private design must disable (the private-endpoint targets). */
const PRIVATE_TYPES = new Set([
  'microsoft.cognitiveservices/accounts',
  'microsoft.search/searchservices',
  'microsoft.storage/storageaccounts',
  'microsoft.keyvault/vaults',
  'microsoft.documentdb/databaseaccounts',
]);

const short = (id: string) => id.split('/').slice(-2).join('/');

/**
 * Smoke tests from what ARM reports (spec 4.8). Reachability from inside the VNet needs an agent in
 * the VNet, so it is reported as skipped - never as passed.
 */
export function smokeChecks(input: {
  stack: StackSummary;
  rows: ResourceRow[];
  modelDeployments: Array<{ account: string; name: string; provisioningState: string | null }>;
  isPrivate: boolean;
}): OperateCheck[] {
  const { stack, rows, modelDeployments, isPrivate } = input;
  const checks: OperateCheck[] = [];

  checks.push(
    stack.state === 'succeeded'
      ? { name: 'Deployment stack', status: 'passed', detail: `The stack is ${stack.provisioningState} and manages ${stack.resourceIds.length} resource(s).` }
      : { name: 'Deployment stack', status: 'failed', detail: `The stack is ${stack.provisioningState}${stack.errors.length ? `: ${stack.errors[0].message}` : ''}.` },
  );

  const notReady = rows.filter((r) => r.provisioningState && r.provisioningState.toLowerCase() !== 'succeeded');
  checks.push(
    notReady.length
      ? { name: 'Resources provisioned', status: 'failed', detail: `${notReady.length} resource(s) are not in the Succeeded state.`, resources: notReady.map((r) => `${short(r.id)} (${r.provisioningState})`) }
      : { name: 'Resources provisioned', status: rows.length ? 'passed' : 'warning', detail: rows.length ? `All ${rows.length} resource(s) Resource Graph returned are Succeeded.` : 'Resource Graph returned none of the stack\'s resources yet - it can lag a few minutes behind a deployment.' },
  );

  const exposed = rows.filter((r) => PRIVATE_TYPES.has(r.type.toLowerCase()) && (r.publicNetworkAccess ?? '').toLowerCase() !== 'disabled');
  checks.push(
    !isPrivate
      ? { name: 'Public network access', status: 'skipped', detail: 'The design is public (no private endpoints), so public access is expected.' }
      : exposed.length
        ? { name: 'Public network access', status: 'failed', detail: `${exposed.length} resource(s) the design keeps private still allow public network access.`, resources: exposed.map((r) => `${short(r.id)} (${r.publicNetworkAccess ?? 'not set'})`) }
        : { name: 'Public network access', status: 'passed', detail: 'Every private-endpoint target has public network access disabled.' },
  );

  const badModels = modelDeployments.filter((d) => (d.provisioningState ?? '').toLowerCase() !== 'succeeded');
  checks.push(
    modelDeployments.length === 0
      ? { name: 'Model deployments', status: 'failed', detail: 'No model deployment was found on the AI account.' }
      : badModels.length
        ? { name: 'Model deployments', status: 'failed', detail: `${badModels.length} model deployment(s) are not Succeeded.`, resources: badModels.map((d) => `${d.account}/${d.name} (${d.provisioningState ?? 'unknown'})`) }
        : { name: 'Model deployments', status: 'passed', detail: `${modelDeployments.map((d) => d.name).join(', ')} provisioned. (Answering a prompt needs a data-plane call from inside the network.)` },
  );

  const apps = rows.filter((r) => r.type.toLowerCase() === 'microsoft.app/containerapps');
  const unready = apps.filter((a) => !a.latestRevisionName || a.latestRevisionName !== a.latestReadyRevisionName || (a.runningStatus && a.runningStatus.toLowerCase() !== 'running'));
  if (apps.length) {
    checks.push(
      unready.length
        ? { name: 'Container App', status: 'failed', detail: 'The latest revision is not ready - check the image and the app logs in Log Analytics.', resources: unready.map((a) => `${a.name} (latest ${a.latestRevisionName ?? 'none'}, ready ${a.latestReadyRevisionName ?? 'none'}${a.runningStatus ? `, ${a.runningStatus}` : ''})`) }
        : { name: 'Container App', status: 'passed', detail: `${apps.map((a) => a.name).join(', ')}: the latest revision is ready.` },
    );
  }

  checks.push({ name: 'Reachable from inside the VNet', status: 'skipped', detail: 'Needs a test agent inside the VNet (private endpoints are not reachable from this server). Run it from a jump box or a pipeline agent in the VNet.' });
  return checks;
}

/** The worst status of a set of checks; skipped ones do not count. */
export function overallStatus(checks: OperateCheck[]): 'passed' | 'failed' | 'warning' {
  if (checks.some((c) => c.status === 'failed')) return 'failed';
  if (checks.some((c) => c.status === 'warning')) return 'warning';
  return 'passed';
}

/** Reads the stack's resources from Resource Graph (one query, no per-type API versions). */
export async function stackResourceRows(arm: ArmClient, subscriptionId: string, resourceIds: string[]): Promise<ResourceRow[]> {
  if (!resourceIds.length) return [];
  const ids = resourceIds.slice(0, 400).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  const rows = await resourceGraph(
    arm,
    subscriptionId,
    `Resources | where id in~ (${ids})
| project id, name, type, provisioningState = tostring(properties.provisioningState), publicNetworkAccess = tostring(properties.publicNetworkAccess),
          latestRevisionName = tostring(properties.latestRevisionName), latestReadyRevisionName = tostring(properties.latestReadyRevisionName), runningStatus = tostring(properties.runningStatus)`,
  );
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), type: String(r.type),
    provisioningState: s(r.provisioningState), publicNetworkAccess: s(r.publicNetworkAccess),
    latestRevisionName: s(r.latestRevisionName), latestReadyRevisionName: s(r.latestReadyRevisionName), runningStatus: s(r.runningStatus),
  }));
}

/** Model deployments on each AI account of the stack. */
export async function modelDeploymentsOf(arm: ArmClient, rows: ResourceRow[]): Promise<Array<{ account: string; name: string; provisioningState: string | null }>> {
  const accounts = rows.filter((r) => r.type.toLowerCase() === 'microsoft.cognitiveservices/accounts');
  const out: Array<{ account: string; name: string; provisioningState: string | null }> = [];
  for (const a of accounts) {
    const deployments = await arm.list<{ name: string; properties?: { provisioningState?: string } }>(`${a.id}/deployments?api-version=${API.aiDeployments}`);
    out.push(...deployments.map((d) => ({ account: a.name, name: d.name, provisioningState: d.properties?.provisioningState ?? null })));
  }
  return out;
}

// ---- Drift ----

export interface DriftItem {
  resource: string;
  type: string;
  changeType: string;
  propertyChanges: number;
}

/**
 * Drift from a what-if of the deployed bundle: anything the stack would have to change back.
 * Create = a managed resource was deleted outside the stack; Modify = changed by hand; Delete
 * cannot happen in incremental mode but is reported if seen. NoChange and Ignore are not drift.
 */
export function driftFrom(changes: WhatIfChange[]): { drifted: boolean; items: DriftItem[] } {
  const items = changes
    .filter((c) => c.changeType === 'Create' || c.changeType === 'Modify' || c.changeType === 'Delete')
    .map((c) => ({ resource: c.resourceId, type: c.type, changeType: c.changeType, propertyChanges: c.propertyChanges }));
  return { drifted: items.length > 0, items };
}

// ---- Budget (Microsoft.Consumption) ----

export const budgetName = (stackName: string) => `${stackName}-budget`.slice(0, 63);

/** A monthly cost budget with actual-cost alerts at 80% and 100% (spec 4.8), starting this month. */
export function budgetBody(amount: number, contactEmails: string[], now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().replace('.000Z', 'Z');
  const alert = (threshold: number) => ({ enabled: true, operator: 'GreaterThanOrEqualTo', threshold, thresholdType: 'Actual', contactEmails });
  return {
    properties: {
      category: 'Cost',
      amount: Math.max(1, Math.ceil(amount)),
      timeGrain: 'Monthly',
      timePeriod: { startDate: start },
      notifications: { actual80: alert(80), actual100: alert(100) },
    },
  };
}

const rgPath = (subscriptionId: string, resourceGroup: string) => `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}`;

export async function putBudget(arm: ArmClient, target: { subscriptionId: string; resourceGroup: string }, name: string, body: ReturnType<typeof budgetBody>): Promise<unknown> {
  return arm.put(`${rgPath(target.subscriptionId, target.resourceGroup)}/providers/Microsoft.Consumption/budgets/${encodeURIComponent(name)}?api-version=${API.budgets}`, body);
}

/** Deletes the budget; a budget that is already gone is fine. */
export async function deleteBudget(arm: ArmClient, target: { subscriptionId: string; resourceGroup: string }, name: string): Promise<void> {
  try {
    await arm.delete(`${rgPath(target.subscriptionId, target.resourceGroup)}/providers/Microsoft.Consumption/budgets/${encodeURIComponent(name)}?api-version=${API.budgets}`);
  } catch (err) {
    if (!(err instanceof ArmError && err.status === 404)) throw err;
  }
}

// ---- Teardown ----

/**
 * Deletes the Deployment Stack and every resource it manages (spec 4.8: "removes all use-case
 * resources and nothing else" - resources outside the stack are untouched). ARM accepts it and
 * deletes asynchronously; the stack then returns 404.
 */
export async function deleteStack(arm: ArmClient, stackId: string): Promise<void> {
  await arm.delete(`${stackId}?unmanageAction.Resources=delete&unmanageAction.ResourceGroups=detach&unmanageAction.ManagementGroups=detach&api-version=${API.stacks}`);
}
