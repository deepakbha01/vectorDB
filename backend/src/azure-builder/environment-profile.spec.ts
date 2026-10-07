import { SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile, deriveConstraints, RAG_PRIVATE_DNS_ZONES, readResourceGraphRows, validateEnvironmentProfile } from './environment-profile';

const SUB = '11111111-2222-4333-8444-555555555555';
const NOW = '2026-10-07T10:00:00.000Z';
const id = (rg: string, type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/${type}/${name}`;

describe('readResourceGraphRows', () => {
  it('accepts a bare array, an az CLI { data } object, and a JSON string', () => {
    const rows = [{ id: 'a', type: 'microsoft.keyvault/vaults' }];
    expect(readResourceGraphRows(rows).rows).toHaveLength(1);
    expect(readResourceGraphRows({ data: rows, count: 1 }).rows).toHaveLength(1);
    expect(readResourceGraphRows(JSON.stringify({ data: rows })).rows).toHaveLength(1);
  });

  it('reports unreadable input instead of throwing', () => {
    expect(readResourceGraphRows('not json').problems[0]).toContain('not valid JSON');
    expect(readResourceGraphRows({ nope: true }).problems[0]).toContain('Expected an array');
    const partial = readResourceGraphRows([{ id: 'a', type: 'microsoft.keyvault/vaults' }, { id: 'b' }]);
    expect(partial.rows).toHaveLength(1);
    expect(partial.problems[0]).toContain('1 row(s) had no "type"');
  });
});

describe('buildEnvironmentProfile', () => {
  const rows = [
    { id: id('rg-net', 'Microsoft.Network/virtualNetworks', 'vnet-hub-prod-cin'), name: 'vnet-hub-prod-cin', type: 'Microsoft.Network/virtualNetworks', location: 'Central India', addressSpace: ['10.0.0.0/16'] },
    { id: id('rg-net', 'Microsoft.Network/virtualNetworks', 'vnet-apps'), name: 'vnet-apps', type: 'microsoft.network/virtualnetworks', location: 'centralindia', properties: { addressSpace: { addressPrefixes: ['10.1.0.0/16'] } } },
    { id: id('rg-dns', 'Microsoft.Network/privateDnsZones', 'privatelink.openai.azure.com'), name: 'PrivateLink.OpenAI.Azure.com', type: 'microsoft.network/privatednszones' },
    { id: id('rg-mon', 'Microsoft.OperationalInsights/workspaces', 'log-1'), name: 'log-1', type: 'microsoft.operationalinsights/workspaces', location: 'centralindia' },
    { id: id('rg-ai', 'Microsoft.CognitiveServices/accounts', 'aoai'), name: 'aoai', type: 'microsoft.cognitiveservices/accounts', location: 'centralindia', kind: 'OpenAI', sku: { name: 'S0' }, publicAccess: 'Disabled' },
  ];

  it('maps Resource Graph rows into the profile, normalising case and region names', () => {
    const p = buildEnvironmentProfile(SUB, rows, {}, NOW);
    expect(p.network.vnets.map((v) => [v.name, v.location, v.addressPrefixes[0]])).toEqual([['vnet-hub-prod-cin', 'centralindia', '10.0.0.0/16'], ['vnet-apps', 'centralindia', '10.1.0.0/16']]);
    expect(p.network.hubVnetId).toContain('vnet-hub-prod-cin'); // named like a hub
    expect(p.network.privateDnsZones).toEqual(['privatelink.openai.azure.com']);
    expect(p.monitoring.logAnalyticsId).toContain('log-1'); // the only workspace
    expect(p.ai.existingAccounts[0]).toMatchObject({ kind: 'OpenAI', sku: 'S0', publicNetworkAccess: 'Disabled' });
    expect(p.resourceCount).toBe(5);
  });

  it('lets form input override discovered values and carry policy and quota', () => {
    const p = buildEnvironmentProfile(SUB, rows, {
      hubVnetId: id('rg-net', 'Microsoft.Network/virtualNetworks', 'vnet-apps'),
      allowedLocations: ['Central India', 'southindia', 'southindia'],
      requiredTags: [' owner ', 'costCenter'],
      denyPublicNetworkAccess: true,
      modelQuota: [{ region: 'Central India', model: 'gpt-4o', limitTpm: 100, usedTpm: 10 }],
    }, NOW);
    expect(p.network.hubVnetId).toContain('vnet-apps');
    expect(p.policy.allowedLocations).toEqual(['centralindia', 'southindia']);
    expect(p.policy.requiredTags).toEqual(['owner', 'costCenter']);
    expect(p.ai.modelQuota[0]).toEqual({ region: 'centralindia', model: 'gpt-4o', sku: 'Standard', limitTpm: 100, usedTpm: 10 });
  });

  it('leaves the hub and workspace unset when they are ambiguous', () => {
    const p = buildEnvironmentProfile(SUB, [rows[1], rows[3], { ...rows[3], id: 'x2', name: 'log-2' }], {}, NOW);
    expect(p.network.hubVnetId).toBeNull();
    expect(p.monitoring.logAnalyticsId).toBeNull();
  });
});

describe('validateEnvironmentProfile', () => {
  it('accepts the sample and rejects bad values with readable messages', () => {
    const sample = buildEnvironmentProfile(SAMPLE_SUBSCRIPTION_ID, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_FORM_INPUT, NOW);
    expect(validateEnvironmentProfile(sample)).toEqual([]);
    const bad = buildEnvironmentProfile('not-a-guid', [], { secureScore: 120, hubVnetId: 'vnet-hub', modelQuota: [{ region: 'centralindia', model: 'gpt-4o', limitTpm: 10, usedTpm: 20 }] }, 'later');
    const errors = validateEnvironmentProfile(bad);
    expect(errors).toEqual(expect.arrayContaining([
      'subscriptionId must be a subscription GUID.',
      'scannedAt must be an ISO date-time.',
      'secureScore must be between 0 and 100.',
      expect.stringContaining('used TPM (20) is above the limit (10)'),
      expect.stringContaining('hubVnetId must be an Azure resource ID'),
    ]));
  });
});

describe('deriveConstraints', () => {
  const sample = buildEnvironmentProfile(SAMPLE_SUBSCRIPTION_ID, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_FORM_INPUT, NOW);

  it('derives what the design must respect from the sample landing zone', () => {
    const c = deriveConstraints(sample, 'centralindia');
    expect(c.targetRegionAllowed).toBe(true);
    expect(c.privateEndpointsRequired).toBe(true);
    expect(c.requiredTags).toEqual(['costCenter', 'owner']);
    expect(c.reuse.map((r) => r.component)).toEqual(['hub-vnet', 'log-analytics', 'key-vault']);
    // The sample has openai, blob and vault zones - search and cognitiveservices are missing
    expect(c.missingPrivateDnsZones).toEqual(['privatelink.cognitiveservices.azure.com', 'privatelink.search.windows.net']);
    expect(c.modelQuota.map((q) => [q.model, q.headroomPercent])).toEqual([['gpt-4o', 87], ['text-embedding-3-large', 89]]);
  });

  it('flags a target region outside the allowed locations and low quota headroom', () => {
    const c = deriveConstraints(sample, 'South India');
    expect(c.targetRegion).toBe('southindia');
    expect(c.targetRegionAllowed).toBe(true);
    expect(c.warnings.some((w) => w.includes('Only 10% of gpt-4o'))).toBe(true);
    const blocked = deriveConstraints(sample, 'westeurope');
    expect(blocked.targetRegionAllowed).toBe(false);
    expect(blocked.warnings[0]).toContain('not in the allowed locations');
  });

  it('asks for no private DNS zones when public access is allowed', () => {
    const open = buildEnvironmentProfile(SUB, [], { denyPublicNetworkAccess: false }, NOW);
    const c = deriveConstraints(open, 'centralindia');
    expect(c.privateEndpointsRequired).toBe(false);
    expect(c.missingPrivateDnsZones).toEqual([]);
    expect(c.targetRegionAllowed).toBeNull(); // no allowed-locations policy
    const locked = deriveConstraints(buildEnvironmentProfile(SUB, [], { denyPublicNetworkAccess: true }, NOW), 'centralindia');
    expect(locked.missingPrivateDnsZones).toEqual(RAG_PRIVATE_DNS_ZONES);
  });
});
