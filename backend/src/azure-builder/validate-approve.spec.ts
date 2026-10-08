import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ArchitectureSpec, AzureCatalog, DEFAULT_OPTIONS, designArchitecture } from './architecture';
import { SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile } from './environment-profile';
import { normaliseEnvInputs, parseCidr, validateEnvInputs } from './iac-inputs';
import { UseCaseSpec } from './use-case-spec';
import { assessWhatIf, AssessContext, bundleHash, parseArmWhatIf, parseResourceId, planWhatIf, WhatIfChange } from './validate-approve';

const catalog = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/azure-builder.yaml'), 'utf8')) as AzureCatalog;
const sample = buildEnvironmentProfile(SAMPLE_SUBSCRIPTION_ID, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_FORM_INPUT, '2026-10-07T00:00:00.000Z');
const UC = '7f3c2a10-1111-4222-8333-944445555666';
const SUB = '11111111-2222-4333-8444-555555555555';
const RG = 'rg-uc-hr-prod';
const hr: UseCaseSpec = {
  name: 'HR policy assistant',
  business: { problem: 'Employees cannot find answers in 400 HR policy documents', kpis: ['Deflect 30% of HR tickets'], sponsor: 'CHRO', costCenter: 'HR-001' },
  users: { type: 'internal', count: 5000, peakConcurrent: 200, channels: ['web', 'teams'] },
  data: [{ source: 'SharePoint HR site', format: 'pdf/docx', volumeGb: 20, classification: 'confidential', containsPersonalData: false, refresh: 'daily' }],
  constraints: { regions: ['centralindia'], dataResidency: 'IN', compliance: ['DPDP'], latencyMs: 3000, availability: '99.9', monthlyBudgetUsd: 5000 },
  environment: 'prod',
  owner: 'architect@example.com',
  pattern: { id: 'rag-assistant', confidence: 0.8, rationale: 'r', overriddenBy: null, overrideReason: null, classifiedAs: 'rag-assistant', missingInfo: [], riskClass: 'high', supportedInMvp: true },
};
const spec: ArchitectureSpec = designArchitecture({ useCase: hr, useCaseId: UC, useCaseVersion: 3, profile: sample, profileVersion: 2, connection: { region: 'centralindia', deploymentModel: 'hub_and_spoke' }, options: DEFAULT_OPTIONS, catalog });
const plan = planWhatIf({ spec, env: 'prod', workload: 'hrpolicy', regionAbbreviation: 'cin', subscriptionId: SUB, resourceGroup: RG, useCaseId: UC, existingNames: ['vnet-hub-prod-cin-001', 'id-hrpolicy-prod-cin-001'] });
const ctx = (over: Partial<AssessContext> = {}): AssessContext => ({ spec, source: 'planned', allowedLocations: ['centralindia', 'southindia'], useCaseId: UC, subscriptionId: SUB, resourceGroup: RG, plan, ...over });

/** An ARM what-if (az deployment group what-if --no-pretty-print) for this plan, as Azure would return it. */
function armFor(changes: WhatIfChange[], tweak: (c: any) => any = (c) => c, extra: any[] = []) {
  const tags = { useCaseId: UC, owner: 'architect@example.com', costCenter: 'HR-001', environment: 'prod', createdBy: 'ai-factory-builder' };
  const rows = changes
    .filter((c) => c.changeType === 'Create' && !c.type.startsWith('Microsoft.Authorization'))
    .map((c) => tweak({
      resourceId: c.resourceId.replace(/xxxx/g, 'ab12'),
      changeType: 'Create',
      before: null,
      after: { location: c.location ?? 'centralindia', tags: c.type.split('/').length === 2 ? tags : undefined, properties: { publicNetworkAccess: 'Disabled' } },
      delta: [],
    }));
  return JSON.stringify({ status: 'Succeeded', changes: [...rows, ...extra], error: null });
}

describe('bundleHash', () => {
  it('is stable, order-independent and changes with any byte', () => {
    const a = [{ path: 'b', content: '1' }, { path: 'a', content: '2' }];
    expect(bundleHash(a)).toBe(bundleHash([...a].reverse()));
    expect(bundleHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(bundleHash([{ path: 'b', content: '1 ' }, a[1]])).not.toBe(bundleHash(a));
  });
});

describe('required inputs', () => {
  it('parses and aligns CIDRs', () => {
    expect(parseCidr('10.20.0.0/22')).toMatchObject({ prefix: 22 });
    expect(parseCidr('10.20.1.0/22')).toBeNull(); // not the first address of its block
    expect(parseCidr('300.1.1.1/8')).toBeNull();
  });

  it('checks size, private ranges, formats and overlaps with each other and with Discover', () => {
    const vnets = [{ name: 'vnet-hub', addressPrefixes: ['10.0.0.0/16'] }];
    expect(validateEnvInputs({ dev: { vnetAddressPrefix: '10.20.0.0/22' }, test: { vnetAddressPrefix: '10.20.4.0/22' }, prod: { vnetAddressPrefix: '10.30.0.0/21', containerImage: 'myacr.azurecr.io/assistant-api:1.0.0', privateDnsZoneResourceGroupId: `/subscriptions/${SUB}/resourceGroups/rg-hub-dns` } }, vnets)).toEqual([]);
    const p = validateEnvInputs({ dev: { vnetAddressPrefix: '10.0.4.0/22' }, test: { vnetAddressPrefix: '10.0.4.0/23' }, prod: { vnetAddressPrefix: '8.8.0.0/22', containerImage: 'latest', privateDnsZoneResourceGroupId: 'rg-hub-dns' } }, vnets);
    expect(p.join(' ')).toContain('overlaps vnet-hub');
    expect(p.join(' ')).toContain('too small');
    expect(p.join(' ')).toContain('not a private (RFC 1918)');
    expect(p.join(' ')).toContain('not an image reference');
    expect(p.join(' ')).toContain('must be a resource ID');
    expect(validateEnvInputs({ dev: { vnetAddressPrefix: '10.20.0.0/22' }, prod: { vnetAddressPrefix: '10.20.0.0/21' } }, [])[0]).toContain('overlap');
  });

  it('treats blanks as not provided', () => {
    expect(normaliseEnvInputs({ dev: { vnetAddressPrefix: ' 10.20.0.0/22 ', containerImage: '  ' }, test: { vnetAddressPrefix: '' } })).toEqual({ dev: { vnetAddressPrefix: '10.20.0.0/22' } });
  });
});

describe('planWhatIf (offline)', () => {
  it('lists what the bundle creates, with CAF names, and what it only references', () => {
    const creates = plan.filter((c) => c.changeType === 'Create').map((c) => `${c.type} ${c.name}`);
    expect(creates).toEqual(expect.arrayContaining([
      'Microsoft.CognitiveServices/accounts oai-hrpolicy-prod-cin-001-xxxx',
      'Microsoft.Network/virtualNetworks vnet-hrpolicy-prod-cin-001',
      'Microsoft.Network/privateEndpoints pep-oai-hrpolicy-prod-cin-001-xxxx-account-0',
      'Microsoft.Network/privateDnsZones privatelink.search.windows.net',
      'Microsoft.BotService/botServices bot-hrpolicy-prod-cin-001',
    ]));
    expect(plan.filter((c) => c.changeType === 'NoChange' && !c.owned).map((c) => c.type)).toEqual(expect.arrayContaining(['Microsoft.OperationalInsights/workspaces', 'Microsoft.Network/virtualNetworks', 'Microsoft.Network/privateDnsZones']));
    expect(plan.find((c) => c.name === 'id-hrpolicy-prod-cin-001')!.note).toContain('already exists');
  });

  it('passes the rules (no blocking), flagging the name collision as a risk', () => {
    const a = assessWhatIf(plan, ctx());
    expect(a.blocking).toEqual([]);
    expect(a.risks.join(' ')).toContain('already exists');
    expect(a.counts.Create).toBeGreaterThan(15);
  });
});

describe('parseResourceId', () => {
  it('splits nested types and names', () => {
    expect(parseResourceId(`/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.CognitiveServices/accounts/oai/deployments/chat`)).toMatchObject({ type: 'Microsoft.CognitiveServices/accounts/deployments', name: 'oai/chat' });
  });
});

describe('ARM what-if import and the approval rules (spec 4.6)', () => {
  const assessArm = (raw: string) => {
    const r = parseArmWhatIf(raw, UC);
    return { r, a: assessWhatIf(r.changes, ctx({ source: 'arm', armStatus: r.status, armError: r.error, armProblems: r.problems })) };
  };

  it('accepts a matching, successful what-if', () => {
    const { r, a } = assessArm(armFor(plan));
    expect(r.status).toBe('succeeded');
    expect(a.blocking).toEqual([]);
    expect(a.risks).toEqual([]);
  });

  it('also reads the REST shape (properties.changes)', () => {
    const rest = JSON.parse(armFor(plan));
    expect(parseArmWhatIf(JSON.stringify({ status: 'Succeeded', properties: { changes: rest.changes } }), UC).changes.length).toBe(rest.changes.length);
  });

  it('blocks a delete of a resource this use case does not own, but only warns for its own', () => {
    const other = { resourceId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/stfinance01`, changeType: 'Delete', before: { location: 'centralindia', tags: { useCaseId: 'someone-else' } }, after: null };
    const mine = { resourceId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/stold01`, changeType: 'Delete', before: { location: 'centralindia', tags: { useCaseId: UC } }, after: null };
    const { a } = assessArm(armFor(plan, (c) => c, [other, mine]));
    expect(a.blocking.join(' ')).toContain('stfinance01 would be deleted, and it does not belong to this use case');
    expect(a.risks.join(' ')).toContain("stold01 (this use case's) would be deleted");
  });

  it('blocks a what-if for another target, another bundle, a disallowed region or public access', () => {
    expect(assessArm(armFor(plan, (c) => ({ ...c, resourceId: c.resourceId.replace(RG, 'rg-other') }))).a.blocking.join(' ')).toContain('outside the connected target');
    expect(assessArm(armFor(plan.filter((c) => !c.name.startsWith('srch-')))).a.blocking.join(' ')).toContain('does not match the bundle');
    expect(assessArm(armFor(plan, (c) => (c.resourceId.includes('/searchServices/') ? { ...c, after: { ...c.after, location: 'eastus' } } : c))).a.blocking.join(' ')).toContain('which the policy does not allow');
    expect(assessArm(armFor(plan, (c) => (c.resourceId.includes('/vaults/') ? { ...c, after: { ...c.after, properties: { publicNetworkAccess: 'Enabled' } } } : c))).a.blocking.join(' ')).toContain('would allow public network access');
  });

  it('flags missing tags and changes to shared resources as risks', () => {
    const shared = { resourceId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/vnet-shared`, changeType: 'Modify', before: { location: 'centralindia', tags: {} }, after: { location: 'centralindia', tags: {} }, delta: [{ path: 'properties.subnets' }] };
    const { a } = assessArm(armFor(plan, (c) => (c.resourceId.includes('/vaults/') ? { ...c, after: { ...c.after, tags: { owner: 'x' } } } : c), [shared]));
    expect(a.blocking).toEqual([]);
    expect(a.risks.join(' ')).toContain('without the tag(s) useCaseId, costCenter, environment, createdBy');
    expect(a.risks.join(' ')).toContain('vnet-shared is shared and would be modified (1 property)');
  });

  it('blocks a failed or unreadable what-if', () => {
    expect(assessArm(JSON.stringify({ status: 'Failed', error: { code: 'InvalidTemplate', message: 'Bad CIDR' } })).a.blocking[0]).toContain('Bad CIDR');
    const bad = parseArmWhatIf('not json', UC);
    expect(bad.status).toBe('failed');
    expect(bad.problems[0]).toContain('--no-pretty-print');
  });
});
