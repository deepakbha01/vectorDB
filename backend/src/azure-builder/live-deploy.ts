import { ArmClient } from './arm-client';
import { ArmPermission, actionAllowed } from './live-azure';
import { TargetEnv } from './iac-bundle';

/**
 * Azure AI Factory Builder - live Phases 5 (what-if) and 6 (Deploy), Wave 6b. Deployment is
 * spec 4.7 Mode B: an Azure Deployment Stack at resource-group scope, so every resource the
 * bundle creates is managed (and later torn down) as one unit, with deny settings that stop
 * them being deleted outside the stack. Pure helpers are exported for tests.
 */

const API = { deployments: '2024-03-01', stacks: '2024-03-01', permissions: '2022-04-01' };

const rgPath = (subscriptionId: string, resourceGroup: string) => `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}`;

/** ARM names: letters, digits, '-', '_', '.', '(' and ')'; at most 64 characters for a deployment. */
const armName = (s: string) => s.replace(/[^\w.()-]/g, '-').slice(0, 64);

export const whatIfDeploymentName = (workload: string, env: TargetEnv, iacVersion: number) => armName(`azb-${workload}-${env}-v${iacVersion}-whatif`);
/** One stack per workload and environment: a newer bundle updates the same stack. */
export const stackName = (workload: string, env: TargetEnv) => armName(`azb-${workload}-${env}`);

/** Runs an ARM what-if at resource-group scope (spec 4.6) and returns Azure's raw result, the same JSON `az deployment group what-if --no-pretty-print` prints. */
export async function runLiveWhatIf(
  arm: ArmClient,
  target: { subscriptionId: string; resourceGroup: string },
  deploymentName: string,
  template: Record<string, unknown>,
  parameters: Record<string, { value: unknown }>,
): Promise<unknown> {
  return arm.postLongRunning(
    `${rgPath(target.subscriptionId, target.resourceGroup)}/providers/Microsoft.Resources/deployments/${encodeURIComponent(deploymentName)}/whatIf?api-version=${API.deployments}`,
    { properties: { mode: 'Incremental', template, parameters, whatIfSettings: { resultFormat: 'FullResourcePayloads' } } },
  );
}

export type DenyMode = 'denyDelete' | 'none';

/**
 * Deny settings need `deploymentStacks/manageDenySetting/action` (Owner or Azure Deployment Stack Owner).
 * Without it the stack is created with no deny settings, and the deployment record says so.
 */
export async function denyModeFor(arm: ArmClient, target: { subscriptionId: string; resourceGroup: string }): Promise<DenyMode> {
  const perms = await arm.list<ArmPermission>(`${rgPath(target.subscriptionId, target.resourceGroup)}/providers/Microsoft.Authorization/permissions?api-version=${API.permissions}`);
  return actionAllowed(perms, 'Microsoft.Resources/deploymentStacks/manageDenySetting/action') ? 'denyDelete' : 'none';
}

export interface ArmStack {
  id?: string;
  name?: string;
  properties?: {
    provisioningState?: string;
    deploymentId?: string;
    outputs?: Record<string, { type?: string; value?: unknown }>;
    resources?: Array<{ id?: string; status?: string; denyStatus?: string }>;
    failedResources?: Array<{ id?: string; error?: ArmErrorDetail }>;
    error?: ArmErrorDetail;
    duration?: string;
  };
}

export interface ArmErrorDetail {
  code?: string;
  message?: string;
  target?: string;
  details?: ArmErrorDetail[];
}

/** Creates or updates the stack (PUT); ARM accepts it and deploys asynchronously. */
export async function putDeploymentStack(
  arm: ArmClient,
  target: { subscriptionId: string; resourceGroup: string },
  name: string,
  input: { template: Record<string, unknown>; parameters: Record<string, { value: unknown }>; denyMode: DenyMode; description: string; tags: Record<string, string> },
): Promise<ArmStack> {
  return arm.put<ArmStack>(`${rgPath(target.subscriptionId, target.resourceGroup)}/providers/Microsoft.Resources/deploymentStacks/${encodeURIComponent(name)}?api-version=${API.stacks}`, {
    tags: input.tags,
    properties: {
      description: input.description.slice(0, 4096),
      template: input.template,
      parameters: input.parameters,
      // Resources a later bundle drops are detached, not deleted; teardown (Phase 7) deletes explicitly.
      actionOnUnmanage: { resources: 'detach', resourceGroups: 'detach', managementGroups: 'detach' },
      denySettings: { mode: input.denyMode, applyToChildScopes: false },
    },
  });
}

export async function getDeploymentStack(arm: ArmClient, stackId: string): Promise<ArmStack> {
  return arm.get<ArmStack>(`${stackId}?api-version=${API.stacks}`);
}

/** Deploy states, then the teardown states Phase 7 adds (tearing_down -> torn_down, or teardown_failed). */
export type DeploymentState = 'running' | 'succeeded' | 'failed' | 'canceled' | 'tearing_down' | 'torn_down' | 'teardown_failed';

export interface DeploymentError {
  code: string;
  message: string;
  /** The failing resource, when Azure names one. */
  resource: string | null;
}

export interface StackSummary {
  state: DeploymentState;
  provisioningState: string;
  outputs: Record<string, unknown>;
  resourceIds: string[];
  errors: DeploymentError[];
  armDeploymentId: string | null;
}

/** Collects the most specific messages from ARM's nested error tree (DeploymentFailed -> ResourceDeploymentFailure -> the real cause). */
export function leafErrors(error: ArmErrorDetail | undefined, resource: string | null = null): DeploymentError[] {
  if (!error) return [];
  const here = error.target ?? resource;
  if (error.details?.length) return error.details.flatMap((d) => leafErrors(d, here));
  return [{ code: error.code ?? 'Unknown', message: (error.message ?? 'No message from Azure.').slice(0, 1000), resource: here }];
}

/** Reads a stack's state (spec 4.7: status, outputs, resource IDs; failures with the failing resource and ARM's message). */
export function summariseStack(stack: ArmStack): StackSummary {
  const p = stack.properties ?? {};
  const provisioningState = p.provisioningState ?? 'unknown';
  const lower = provisioningState.toLowerCase();
  const state: DeploymentState = lower === 'succeeded' ? 'succeeded' : lower === 'failed' ? 'failed' : lower === 'canceled' ? 'canceled' : 'running';
  const errors = [
    ...(p.failedResources ?? []).flatMap((r) => leafErrors(r.error, r.id ?? null)),
    ...leafErrors(p.error),
  ];
  const unique = errors.filter((e, i) => errors.findIndex((x) => x.code === e.code && x.message === e.message && x.resource === e.resource) === i);
  return {
    state,
    provisioningState,
    outputs: Object.fromEntries(Object.entries(p.outputs ?? {}).map(([k, v]) => [k, v?.value ?? null])),
    resourceIds: (p.resources ?? []).map((r) => r.id ?? '').filter(Boolean),
    errors: state === 'failed' || state === 'canceled' ? unique.slice(0, 20) : [],
    armDeploymentId: p.deploymentId ?? null,
  };
}
