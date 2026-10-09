import { ArmClient } from './arm-client';
import { budgetBody, budgetName, deleteStack, driftFrom, overallStatus, ResourceRow, smokeChecks, stackResourceRows } from './live-operate';
import { StackSummary } from './live-deploy';

const okStack: StackSummary = { state: 'succeeded', provisioningState: 'succeeded', outputs: {}, resourceIds: ['/a', '/b'], errors: [], armDeploymentId: null };
const row = (over: Partial<ResourceRow>): ResourceRow => ({ id: '/subscriptions/s/resourceGroups/rg/providers/x/y/n', name: 'n', type: 'microsoft.storage/storageaccounts', provisioningState: 'Succeeded', publicNetworkAccess: 'Disabled', latestRevisionName: null, latestReadyRevisionName: null, runningStatus: null, ...over });
const byName = (checks: ReturnType<typeof smokeChecks>) => Object.fromEntries(checks.map((c) => [c.name, c.status]));

describe('smokeChecks', () => {
  it('passes a healthy private deployment and never claims the in-VNet test passed', () => {
    const checks = smokeChecks({
      stack: okStack,
      rows: [row({ type: 'microsoft.cognitiveservices/accounts' }), row({ type: 'microsoft.app/containerapps', name: 'ca-api', publicNetworkAccess: null, latestRevisionName: 'r2', latestReadyRevisionName: 'r2', runningStatus: 'Running' })],
      modelDeployments: [{ account: 'oai', name: 'gpt-4o', provisioningState: 'Succeeded' }],
      isPrivate: true,
    });
    expect(byName(checks)).toEqual({
      'Deployment stack': 'passed', 'Resources provisioned': 'passed', 'Public network access': 'passed', 'Model deployments': 'passed', 'Container App': 'passed', 'Reachable from inside the VNet': 'skipped',
    });
    expect(overallStatus(checks)).toBe('passed');
  });

  it('fails on public access left open, a failed resource, a missing model and an unready revision', () => {
    const checks = smokeChecks({
      stack: okStack,
      rows: [
        row({ type: 'Microsoft.Search/searchServices', name: 'srch', publicNetworkAccess: 'Enabled' }),
        row({ type: 'microsoft.keyvault/vaults', name: 'kv', provisioningState: 'Failed' }),
        row({ type: 'microsoft.app/containerapps', name: 'ca-api', publicNetworkAccess: null, latestRevisionName: 'r3', latestReadyRevisionName: 'r2' }),
      ],
      modelDeployments: [],
      isPrivate: true,
    });
    const s = byName(checks);
    expect(s).toMatchObject({ 'Resources provisioned': 'failed', 'Public network access': 'failed', 'Model deployments': 'failed', 'Container App': 'failed' });
    expect(checks.find((c) => c.name === 'Public network access')!.resources).toEqual(['y/n (Enabled)']);
    expect(overallStatus(checks)).toBe('failed');
  });

  it('skips the public-access check for a public design and warns while Resource Graph has not caught up', () => {
    const checks = smokeChecks({ stack: okStack, rows: [], modelDeployments: [{ account: 'a', name: 'm', provisioningState: 'Succeeded' }], isPrivate: false });
    expect(byName(checks)).toMatchObject({ 'Public network access': 'skipped', 'Resources provisioned': 'warning' });
    expect(overallStatus(checks)).toBe('warning');
  });

  it('reports a failed stack with its first error', () => {
    const checks = smokeChecks({ stack: { ...okStack, state: 'failed', provisioningState: 'failed', errors: [{ code: 'X', message: 'quota', resource: null }] }, rows: [], modelDeployments: [], isPrivate: false });
    expect(checks[0]).toMatchObject({ status: 'failed', detail: 'The stack is failed: quota.' });
  });
});

describe('driftFrom', () => {
  it('counts changes the stack would have to make, not NoChange or Ignore', () => {
    const c = (changeType: any) => ({ resourceId: `/r/${changeType}`, type: 't', name: 'n', changeType, owned: true, location: null, propertyChanges: 2, note: null });
    expect(driftFrom([c('NoChange'), c('Ignore')])).toEqual({ drifted: false, items: [] });
    expect(driftFrom([c('NoChange'), c('Modify'), c('Create')]).items.map((i) => i.changeType)).toEqual(['Modify', 'Create']);
  });
});

describe('budget', () => {
  it('is monthly from the first of this month, rounded up, with alerts at 80% and 100%', () => {
    const b = budgetBody(1653.2, ['owner@contoso.com'], new Date('2026-10-09T15:00:00Z'));
    expect(b.properties).toMatchObject({ category: 'Cost', amount: 1654, timeGrain: 'Monthly', timePeriod: { startDate: '2026-10-01T00:00:00Z' } });
    expect(b.properties.notifications.actual80).toMatchObject({ threshold: 80, thresholdType: 'Actual', operator: 'GreaterThanOrEqualTo', contactEmails: ['owner@contoso.com'] });
    expect(b.properties.notifications.actual100.threshold).toBe(100);
    expect(budgetName('azb-hrpoliassi-dev')).toBe('azb-hrpoliassi-dev-budget');
  });
});

describe('ARM calls', () => {
  it('teardown deletes the stack\'s resources but only detaches resource groups', async () => {
    const arm = { delete: jest.fn().mockResolvedValue(undefined) } as unknown as ArmClient;
    await deleteStack(arm, '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Resources/deploymentStacks/azb-x-dev');
    expect((arm.delete as jest.Mock).mock.calls[0][0]).toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Resources/deploymentStacks/azb-x-dev?unmanageAction.Resources=delete&unmanageAction.ResourceGroups=detach&unmanageAction.ManagementGroups=detach&api-version=2024-03-01');
  });

  it('queries the stack resources in one Resource Graph call, quoting IDs safely', async () => {
    const arm = { post: jest.fn().mockResolvedValue({ data: [{ id: '/r/1', name: 'n', type: 't', provisioningState: 'Succeeded', publicNetworkAccess: '' }] }) } as unknown as ArmClient;
    const rows = await stackResourceRows(arm, 's', ["/r/1", "/r/o'brien"]);
    expect(rows[0]).toMatchObject({ id: '/r/1', provisioningState: 'Succeeded', publicNetworkAccess: null });
    expect((arm.post as jest.Mock).mock.calls[0][1].query).toContain("('/r/1', '/r/o''brien')");
    await expect(stackResourceRows(arm, 's', [])).resolves.toEqual([]);
  });
});
