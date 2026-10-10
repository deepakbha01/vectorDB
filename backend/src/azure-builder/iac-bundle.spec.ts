import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ArchitectureInput, ArchitectureOptions, ArchitectureSpec, AzureCatalog, DEFAULT_OPTIONS, designArchitecture } from './architecture';
import { SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile, EnvironmentProfile } from './environment-profile';
import { bicepString, bicepValue, deriveWorkload, generateIacBundle, IacBundle, IacCatalog, TARGET_ENVS, TargetEnv } from './iac-bundle';
import { parseBicepDiagnostics, validateIacBundle } from './iac-validate';
import { UseCaseSpec } from './use-case-spec';

const catalog = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/azure-builder.yaml'), 'utf8')) as AzureCatalog & { iac: IacCatalog };
const sample = buildEnvironmentProfile(SAMPLE_SUBSCRIPTION_ID, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_FORM_INPUT, '2026-10-07T00:00:00.000Z');
const openProfile: EnvironmentProfile = {
  ...sample,
  network: { vnets: [], hubVnetId: null, privateDnsZones: [] },
  monitoring: { workspaces: [], logAnalyticsId: null },
  policy: { allowedLocations: [], requiredTags: [], denyPublicNetworkAccess: false, deniedSkus: [] },
};

const hr: UseCaseSpec = {
  name: "HR policy assistant - O'Brien's ${team}",
  business: { problem: 'Employees cannot find answers in 400 HR policy documents', kpis: ['Deflect 30% of HR tickets'], sponsor: 'CHRO', costCenter: 'HR-001' },
  users: { type: 'internal', count: 5000, peakConcurrent: 200, channels: ['web', 'teams'] },
  data: [{ source: 'SharePoint HR site', format: 'pdf/docx', volumeGb: 20, classification: 'confidential', containsPersonalData: false, refresh: 'daily' }],
  constraints: { regions: ['centralindia'], dataResidency: 'IN', compliance: ['DPDP'], latencyMs: 3000, availability: '99.9', monthlyBudgetUsd: 5000 },
  environment: 'prod',
  owner: 'architect@example.com',
  pattern: { id: 'rag-assistant', confidence: 0.8, rationale: 'r', overriddenBy: null, overrideReason: null, classifiedAs: 'rag-assistant', missingInfo: [], riskClass: 'high', supportedInMvp: true },
};

function bundleFor(over: { profile?: EnvironmentProfile; options?: ArchitectureOptions; uc?: Partial<UseCaseSpec>; workload?: string } = {}): { bundle: IacBundle; spec: ArchitectureSpec } {
  const base = (env: TargetEnv): ArchitectureInput => ({
    useCase: { ...hr, ...over.uc, environment: env },
    useCaseId: '7f3c2a10-1111-4222-8333-944445555666',
    useCaseVersion: 3,
    profile: over.profile ?? sample,
    profileVersion: 2,
    connection: { region: 'centralindia', deploymentModel: 'hub_and_spoke' },
    options: over.options ?? DEFAULT_OPTIONS,
    catalog,
  });
  const spec = designArchitecture(base((over.uc?.environment ?? hr.environment) as TargetEnv));
  const specsByEnv = Object.fromEntries(TARGET_ENVS.map((e) => [e, designArchitecture(base(e))])) as Record<TargetEnv, ArchitectureSpec>;
  return { spec, bundle: generateIacBundle({ spec, specsByEnv, architectureVersion: 4, workload: over.workload ?? 'hrpolicy', catalog }) };
}
const file = (b: IacBundle, p: string) => b.files.find((f) => f.path === p)?.content ?? '';

describe('Bicep literals', () => {
  it('escapes user text so it cannot end the string or start an interpolation', () => {
    expect(bicepString("O'Brien ${x} \\ \n")).toBe("'O\\'Brien \\${x} \\\\ \\n'");
    expect(bicepValue({ owner: 'a@b.c', 'cost-center': null, n: 2 })).toBe("{\n  owner: 'a@b.c'\n  'cost-center': null\n  n: 2\n}");
  });

  it('derives a CAF-safe workload name', () => {
    expect(deriveWorkload('HR policy assistant')).toBe('hrpoliassi');
    expect(deriveWorkload('Chat')).toBe('chat');
    expect(deriveWorkload('2026 forecasting')).toBe('uc2026foreca');
    expect(deriveWorkload('!!')).toBe('workload');
  });
});

describe('generateIacBundle - the sample landing zone (private, hub, Teams)', () => {
  const { bundle, spec } = bundleFor();
  const main = file(bundle, 'infra/main.bicep');

  it('produces the spec 11.2 layout', () => {
    expect(bundle.root).toBe('uc-7f3c2a10-hr-policy-assistant-o-brien-s-team');
    expect(bundle.files.map((f) => f.path)).toEqual([
      'infra/main.bicep', 'infra/modules/bot-service.bicep',
      'infra/params/dev.bicepparam', 'infra/params/test.bicepparam', 'infra/params/prod.bicepparam',
      '.github/workflows/deploy.yml', 'docs/architecture.md', 'README.md',
    ]);
  });

  it('references every catalog module as a pinned AVM version, and nothing unpinned', () => {
    const refs = [...main.matchAll(/module \w+ '([^']+)'/g)].map((m) => m[1]);
    for (const r of refs.filter((x) => x.startsWith('br/'))) expect(r).toMatch(/^br\/public:avm\/res\/[a-z-]+\/[a-z-]+:\d+\.\d+\.\d+$/);
    expect(refs).toContain('modules/bot-service.bicep');
    for (const c of spec.components.filter((x) => !x.reuseExisting && !['private-endpoints', 'private-dns', 'bot', 'vnet'].includes(x.id))) {
      expect(main).toContain(`br/public:${c.module}:${catalog.iac.avm[c.module]}`);
    }
  });

  it('tags every resource and keeps no secrets in any file (spec 4.5 acceptance)', () => {
    const modules = main.split(/\n(?=module |resource )/).filter((s) => /^(module|resource) /.test(s));
    for (const m of modules) expect(m).toMatch(/\n\s+tags: tags\n/);
    expect(file(bundle, 'infra/modules/bot-service.bicep')).toContain('tags: tags');
    for (const f of bundle.files) {
      // (allowSharedKeyAccess: false is a protective setting, so match key *values* and accessors only)
      expect(f.content).not.toMatch(/listKeys\(|\.primaryKey|primaryAccessKey|primarySharedKey|password\s*[:=]|AccountKey=|-----BEGIN/i);
      expect(f.content).not.toContain('#{');
    }
    expect(main).not.toMatch(/^output .*(key|secret|connectionString)/im);
    const dev = file(bundle, 'infra/params/dev.bicepparam');
    expect(dev).toContain("useCaseId: '7f3c2a10-1111-4222-8333-944445555666'");
    expect(dev).toContain("environment: 'dev'");
    expect(dev).toContain("createdBy: 'ai-factory-builder'");
  });

  it('applies the private, reuse and identity rules', () => {
    expect(main.match(/publicNetworkAccess: 'Disabled'/g)?.length).toBeGreaterThanOrEqual(4);
    expect(main).not.toContain("publicNetworkAccess: 'Enabled'");
    expect(main).toContain('param logAnalyticsWorkspaceResourceId string');
    expect(main).not.toContain('module logAnalytics');
    expect(main).toContain('remoteVirtualNetworkResourceId: hubVnetResourceId');
    expect(main).toContain("var createdPrivateDnsZones = [\n  'privatelink.cognitiveservices.azure.com'\n  'privatelink.search.windows.net'\n]");
    expect(main).toContain("'${privateDnsZoneResourceGroupId}/providers/Microsoft.Network/privateDnsZones/privatelink.openai.azure.com'");
    expect(main).toContain("privateDnsZones/privatelink.blob.${az.environment().suffixes.storage}'"); // no hard-coded cloud host
    expect(main.match(/disableLocalAuth: true/g)?.length).toBeGreaterThanOrEqual(3);
    expect(main).toContain("raiPolicyName: 'Microsoft.DefaultV2'");
    expect(main).toContain('ingressExternal: true'); // Teams reaches the bot from the internet
  });

  it('keeps environment-specific values out of main.bicep and sizes each environment', () => {
    expect(main).not.toMatch(/'(dev|test|prod)'(?!,|\])/); // only in @allowed
    const dev = file(bundle, 'infra/params/dev.bicepparam');
    const prod = file(bundle, 'infra/params/prod.bicepparam');
    expect(dev).toContain("param searchSku = 'basic'");
    expect(prod).toContain("param searchSku = 'standard'");
    expect(prod).toContain('param searchReplicaCount = 2');
    expect(prod).toContain("param storageSkuName = 'Standard_ZRS'");
    expect(prod).toContain('param keyVaultPurgeProtection = true');
    expect(dev).toContain('param keyVaultPurgeProtection = false');
    expect(dev).toContain("param botSku = 'F0'");
    expect(prod).toContain("param vnetAddressPrefix = ''");
  });

  it('lists what it will not invent', () => {
    expect(bundle.requiredInputs.map((r) => r.name)).toEqual(expect.arrayContaining(['vnetAddressPrefix', 'privateDnsZoneResourceGroupId', 'Shared private links', 'Hub-side peering', 'containerImage', 'GitHub OIDC']));
    expect(file(bundle, 'README.md')).toContain('Before the first deployment');
  });

  it('escapes the use case name wherever it appears', () => {
    const prod = file(bundle, 'infra/params/prod.bicepparam');
    expect(main).toContain("for \"HR policy assistant - O'Brien's ${team}\""); // comment only
    expect(prod).not.toContain("O'Brien's ${team}'");
  });

  it('documents the design: Mermaid diagram with every component, cost and ADRs', () => {
    const doc = file(bundle, 'docs/architecture.md');
    for (const c of spec.components) expect(doc).toContain(`n_${c.id.replace(/[^a-zA-Z0-9]/g, '_')}[`);
    expect(doc).toContain('```mermaid');
    expect(doc).toContain('ADR-03');
    const yml = file(bundle, '.github/workflows/deploy.yml');
    expect(yml).toContain('id-token: write');
    expect(yml).toContain('${{ vars.AZURE_CLIENT_ID }}');
    expect(yml).toContain('what-if');
  });

  it('is deterministic', () => {
    expect(bundleFor().bundle).toEqual(bundle);
  });
});

describe('generateIacBundle - variants', () => {
  it('a public design has no network, DNS or private endpoints', () => {
    const { bundle } = bundleFor({ profile: openProfile, uc: { data: [{ ...hr.data[0], classification: 'internal' }], constraints: { ...hr.constraints, dataResidency: null }, users: { ...hr.users, channels: ['web'] } } });
    const main = file(bundle, 'infra/main.bicep');
    expect(main).not.toMatch(/module vnet|privateEndpoints|vnetAddressPrefix|createdPrivateDnsZones/);
    expect(main).toContain("publicNetworkAccess: 'Enabled'");
    expect(main).toContain('module logAnalytics');
    expect(bundle.files.map((f) => f.path)).not.toContain('infra/modules/bot-service.bicep');
    expect(bundle.requiredInputs.map((r) => r.name)).not.toContain('vnetAddressPrefix');
  });

  it('adds the gateway subnet, API Management and Cosmos DB when the architect turned them on', () => {
    const { bundle } = bundleFor({ options: { apiGateway: true, chatHistory: true, deployment: 'auto' } });
    const main = file(bundle, 'infra/main.bicep');
    expect(main).toContain("name: 'snet-apim'");
    expect(main).toContain('availabilityZones: []');
    expect(main).toContain("capacityMode: 'Serverless'");
    expect(main).toContain("service: 'Sql'");
    expect(main).toContain("'https://${names.apim}.azure-api.net/assistant/api/messages'");
    expect(file(bundle, 'infra/params/dev.bicepparam')).toContain("param apimSku = 'Developer'");
    expect(file(bundle, 'infra/params/prod.bicepparam')).toContain("param apimSku = 'StandardV2'");
  });

  it('rejects a workload name that would break CAF names', () => {
    expect(() => bundleFor({ workload: 'HR-Policy' })).toThrow('lower-case');
  });
});

describe('parseBicepDiagnostics', () => {
  it('reads CLI output relative to the bundle root, without duplicates', () => {
    const root = path.join(path.sep, 'tmp', 'azb');
    const out = [
      `${path.join(root, 'infra', 'main.bicep')}(12,5) : Warning no-unused-vars: Variable "x" is declared but never used. [https://aka.ms/bicep/linter/no-unused-vars]`,
      `${path.join(root, 'infra', 'main.bicep')}(12,5) : Warning no-unused-vars: Variable "x" is declared but never used. [https://aka.ms/bicep/linter/no-unused-vars]`,
      `${path.join(root, 'infra', 'main.bicep')}(40,3) : Error BCP037: The property "foo" is not allowed.`,
      'unrelated line',
    ].join('\n');
    expect(parseBicepDiagnostics(out, root)).toEqual([
      { file: 'infra/main.bicep', line: 12, column: 5, level: 'warning', code: 'no-unused-vars', message: 'Variable "x" is declared but never used.' },
      { file: 'infra/main.bicep', line: 40, column: 3, level: 'error', code: 'BCP037', message: 'The property "foo" is not allowed.' },
    ]);
  });

  it('skips (never passes) when no Bicep CLI is configured', async () => {
    const v = await validateIacBundle([], undefined);
    expect(v.status).toBe('skipped');
    expect(v.reason).toContain('AZURE_BUILDER_BICEP_PATH');
  });

  it('skips with the reason when the configured Bicep CLI cannot be started', async () => {
    const v = await validateIacBundle([], path.join(__dirname, 'no-such-bicep.exe'));
    expect(v.status).toBe('skipped');
    expect(v.reason).toMatch(/could not be started \(exit code ENOENT/);
  });
});

// Compiles the generated bundles with the real Bicep CLI (restores AVM modules from the public
// registry). Runs when AZURE_BUILDER_BICEP_PATH points at a Bicep CLI; skipped otherwise.
const bicep = process.env.AZURE_BUILDER_BICEP_PATH;
(bicep ? describe : describe.skip)('generated Bicep compiles with zero errors and no lint warnings (spec 4.5 acceptance)', () => {
  it.each([
    ['private, hub, Teams', {}],
    ['private with gateway and chat history', { options: { apiGateway: true, chatHistory: true, deployment: 'auto' as const } }],
    ['public, no Teams', { profile: openProfile, uc: { data: [{ ...hr.data[0], classification: 'internal' as const }], constraints: { ...hr.constraints, dataResidency: null }, users: { ...hr.users, channels: ['web' as const] } } }],
  ])('%s', async (_name, over) => {
    const v = await validateIacBundle(bundleFor(over).bundle.files, bicep);
    expect(v.diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
    expect(v.status).toBe('passed');
  }, 600_000);
});
