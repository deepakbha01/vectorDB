import { ArmError } from './arm-client';
import { AzureRole } from './azure-builder.enums';
import { actionAllowed, discoverLive, effectivePermissions, quotaFromUsages, roleFromPermissions, summarisePolicy, verifyTarget } from './live-azure';

// What Microsoft.Authorization/permissions returns for the built-in roles.
const OWNER = [{ actions: ['*'], notActions: [] }];
const CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action', 'Microsoft.Blueprint/blueprintAssignments/write', 'Microsoft.Resources/deploymentStacks/manageDenySetting/action'] }];
const READER = [{ actions: ['*/read'], notActions: [] }];
const RBAC_ADMIN = [{ actions: ['Microsoft.Authorization/roleAssignments/write', 'Microsoft.Authorization/roleAssignments/delete', '*/read'], notActions: [] }];

describe('permissions', () => {
  it('matches wildcards case-insensitively and honours notActions', () => {
    expect(actionAllowed(OWNER, 'Microsoft.Resources/deployments/write')).toBe(true);
    expect(actionAllowed(CONTRIBUTOR, 'microsoft.authorization/roleassignments/write')).toBe(false);
    expect(actionAllowed(READER, 'Microsoft.Resources/subscriptions/resourceGroups/read')).toBe(true);
    expect(actionAllowed(READER, 'Microsoft.Resources/deployments/write')).toBe(false);
    expect(actionAllowed([{ actions: ['Microsoft.Web/*'] }], 'Microsoft.WebX/sites/write')).toBe(false); // '.' and '/' are literal
  });

  it.each([
    ['Owner', OWNER, AzureRole.OWNER],
    ['Contributor plus RBAC Administrator', [...CONTRIBUTOR, ...RBAC_ADMIN], AzureRole.OWNER],
    ['Contributor', CONTRIBUTOR, AzureRole.CONTRIBUTOR],
    ['Reader', READER, AzureRole.READER],
    ['nothing', [], AzureRole.UNKNOWN],
  ])('%s maps to %s', (_label, perms, role) => {
    expect(roleFromPermissions(effectivePermissions('/subscriptions/s', perms))).toBe(role);
  });
});

describe('summarisePolicy', () => {
  const def = (guid: string) => `/providers/Microsoft.Authorization/policyDefinitions/${guid}`;

  it('reads allowed locations (intersecting several assignments), required tags and a deny on public access', () => {
    const s = summarisePolicy([
      { name: 'loc1', properties: { policyDefinitionId: def('e56962a6-4747-49cd-b67b-bf8b01975c4c'), parameters: { listOfAllowedLocations: { value: ['centralindia', 'southindia', 'westeurope'] } } } },
      { name: 'loc2', properties: { policyDefinitionId: def('E765B5DE-1225-4BA3-BD56-1AC6695AF988'), parameters: { listOfAllowedLocations: { value: ['Central India', 'southindia'] } } } },
      { name: 'tag', properties: { policyDefinitionId: def('871b6d14-10aa-478d-b590-94f262ecfa99'), parameters: { tagName: { value: 'costCenter' } } } },
      { name: 'tag-rg', properties: { policyDefinitionId: def('96670d01-0a4d-4649-9c89-2d3abc0a5025'), parameters: { tagName: { value: 'owner' } } } },
      { name: 'pna', properties: { displayName: 'Azure AI Services should disable public network access', policyDefinitionId: def('aaaa'), parameters: { effect: { value: 'Deny' } } } },
    ]);
    expect(s).toEqual({ allowedLocations: ['centralindia', 'southindia'], requiredTags: ['costCenter', 'owner'], denyPublicNetworkAccess: true, problems: [] });
  });

  it('ignores assignments not enforced, and reports audit-only public-access policies and unexpanded initiatives', () => {
    const s = summarisePolicy([
      { name: 'loc', properties: { enforcementMode: 'DoNotEnforce', policyDefinitionId: def('e56962a6-4747-49cd-b67b-bf8b01975c4c'), parameters: { listOfAllowedLocations: { value: ['eastus'] } } } },
      { name: 'pna', properties: { displayName: 'Storage accounts should disable public network access', policyDefinitionId: def('bbbb'), parameters: { effect: { value: 'Audit' } } } },
      { name: 'mcsb', properties: { displayName: 'Microsoft cloud security benchmark', policyDefinitionId: '/providers/Microsoft.Authorization/policySetDefinitions/1f3afdf9' } },
    ]);
    expect(s.allowedLocations).toEqual([]);
    expect(s.denyPublicNetworkAccess).toBe(false);
    expect(s.problems.join(' ')).toMatch(/1 public-network-access .* Deny/);
    expect(s.problems.join(' ')).toContain('Microsoft cloud security benchmark');
  });
});

describe('quotaFromUsages', () => {
  it('keeps Azure OpenAI model quota (1 unit = 1,000 TPM), including dotted model names', () => {
    expect(
      quotaFromUsages('centralindia', [
        { name: { value: 'OpenAI.Standard.gpt-4o' }, currentValue: 20, limit: 150 },
        { name: { value: 'OpenAI.GlobalStandard.gpt-4.1' }, currentValue: 0, limit: 450 },
        { name: { value: 'OpenAI.Standard.text-embedding-3-large' }, currentValue: 0, limit: 0 },
        { name: { value: 'AccountCount' }, currentValue: 3, limit: 200 },
      ]),
    ).toEqual([
      { region: 'centralindia', model: 'gpt-4o', sku: 'Standard', limitTpm: 150000, usedTpm: 20000 },
      { region: 'centralindia', model: 'gpt-4.1', sku: 'GlobalStandard', limitTpm: 450000, usedTpm: 0 },
    ]);
  });
});

/** A fake ArmClient answering by URL fragment; a value of Error is thrown. */
function fakeArm(routes: Array<[RegExp, unknown]>) {
  const answer = async (path: string) => {
    const hit = routes.find(([re]) => re.test(path));
    if (!hit) throw new ArmError(404, 'NotFound', `no route for ${path}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return {
    get: jest.fn(answer),
    post: jest.fn((path: string) => answer(path)),
    list: jest.fn(async (path: string) => ((await answer(path)) as { value: unknown[] }).value),
  } as any;
}

const SUB = '51bfc241-927a-44b4-9dc8-2a3af25352b4';

describe('verifyTarget', () => {
  it('reads the role on an existing resource group', async () => {
    const arm = fakeArm([
      [/permissions/, { value: CONTRIBUTOR }],
      [/\/locations\?/, { value: [{ name: 'centralindia' }] }],
      [/resourcegroups\/evectorizeresoruces\?/, { location: 'centralindia' }],
      [/\/subscriptions\/[^/]+\?/, { displayName: 'Evectorize Test', tenantId: 'ef04bcd8-91ce-495c-9393-c645d394493c' }],
    ]);
    const t = await verifyTarget(arm, SUB, 'evectorizeresoruces', 'centralindia');
    expect(t).toMatchObject({ subscriptionName: 'Evectorize Test', resourceGroupExists: true, regionKnown: true, role: AzureRole.CONTRIBUTOR });
    expect(t.permissions.scope).toBe(`/subscriptions/${SUB}/resourceGroups/evectorizeresoruces`);
    expect(arm.list).toHaveBeenCalledWith(expect.stringContaining('/resourceGroups/evectorizeresoruces/providers/Microsoft.Authorization/permissions'));
  });

  it('falls back to subscription permissions for a resource group that does not exist yet', async () => {
    const arm = fakeArm([
      [/permissions/, { value: OWNER }],
      [/\/locations\?/, { value: [{ name: 'centralindia' }] }],
      [/resourcegroups\/rg-new\?/, new ArmError(404, 'ResourceGroupNotFound', 'not found')],
      [/\/subscriptions\/[^/]+\?/, { displayName: 'Evectorize Test', tenantId: 't' }],
    ]);
    const t = await verifyTarget(arm, SUB, 'rg-new', 'eastus');
    expect(t).toMatchObject({ resourceGroupExists: false, regionKnown: false, role: AzureRole.OWNER });
    expect(t.permissions.scope).toBe(`/subscriptions/${SUB}`);
  });
});

describe('discoverLive', () => {
  it('builds rows and policy, quota and secure-score inputs from the subscription', async () => {
    const arm = fakeArm([
      [/ResourceGraph/, { data: [{ id: 'v1', name: 'vnet-hub', type: 'microsoft.network/virtualnetworks', location: 'centralindia', addressSpace: ['10.0.0.0/16'] }] }],
      [/policyAssignments/, { value: [{ name: 'tag', properties: { policyDefinitionId: '/x/871b6d14-10aa-478d-b590-94f262ecfa99', parameters: { tagName: { value: 'owner' } } } }] }],
      [/usages/, { value: [{ name: { value: 'OpenAI.Standard.gpt-4o' }, currentValue: 0, limit: 100 }] }],
      [/secureScores/, { properties: { score: { percentage: 0.724 } } }],
    ]);
    const d = await discoverLive(arm, SUB, 'centralindia');
    expect(d.rows).toHaveLength(1);
    expect(d.form).toMatchObject({ requiredTags: ['owner'], secureScore: 72, modelQuota: [{ model: 'gpt-4o', limitTpm: 100000 }] });
    expect(d.problems).toEqual([]);
    expect(arm.post).toHaveBeenCalledWith(expect.stringContaining('Microsoft.ResourceGraph'), expect.objectContaining({ subscriptions: [SUB] }));
  });

  it('reports what it could not read instead of failing (spec 4.2)', async () => {
    const denied = new ArmError(403, 'AuthorizationFailed', 'no access');
    const arm = fakeArm([
      [/ResourceGraph/, { data: [] }],
      [/policyAssignments/, denied],
      [/usages/, { value: [] }],
      [/secureScores/, new ArmError(404, 'NotFound', 'x')],
    ]);
    const d = await discoverLive(arm, SUB, 'centralindia');
    expect(d.problems).toEqual([
      'Policy assignments could not be read (no permission): no access',
      'No Azure OpenAI quota was found in centralindia - request quota before deploying model endpoints there.',
      'Defender for Cloud secure score is not available for this subscription or user.',
    ]);
  });

  it('follows Resource Graph skip tokens', async () => {
    let page = 0;
    const arm = { post: jest.fn(async () => (++page === 1 ? { data: [{ type: 'a' }], $skipToken: 'tok' } : { data: [{ type: 'b' }] })), get: jest.fn().mockRejectedValue(new ArmError(404, 'x', 'x')), list: jest.fn().mockResolvedValue([]) } as any;
    const d = await discoverLive(arm, SUB, 'centralindia');
    expect(d.rows).toHaveLength(2);
    expect((arm.post.mock.calls[1] as any[])[1].options.$skipToken).toBe('tok');
  });
});
