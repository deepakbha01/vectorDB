import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ArchitectureError, ArchitectureInput, ArchitectureSpec, AzureCatalog, chooseRegion, DEFAULT_OPTIONS, designArchitecture, validateArchitecture, ZONES } from './architecture';
import { validateCatalog } from './architecture-catalog';
import { SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile, EnvironmentProfile } from './environment-profile';
import { UseCaseSpec } from './use-case-spec';

const catalog = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/azure-builder.yaml'), 'utf8')) as AzureCatalog;
const sample = buildEnvironmentProfile(SAMPLE_SUBSCRIPTION_ID, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_FORM_INPUT, '2026-10-07T00:00:00.000Z');
const openProfile: EnvironmentProfile = {
  ...sample,
  network: { vnets: [], hubVnetId: null, privateDnsZones: [] },
  monitoring: { workspaces: [], logAnalyticsId: null },
  policy: { allowedLocations: [], requiredTags: [], denyPublicNetworkAccess: false, deniedSkus: [] },
};

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

const design = (over: Partial<ArchitectureInput> = {}, uc: Partial<UseCaseSpec> = {}): ArchitectureSpec =>
  designArchitecture({
    useCase: { ...hr, ...uc },
    useCaseId: 'uc-1',
    useCaseVersion: 3,
    profile: sample,
    profileVersion: 2,
    connection: { region: 'centralindia', deploymentModel: 'hub_and_spoke' },
    options: DEFAULT_OPTIONS,
    catalog,
    ...over,
  });
const ids = (s: ArchitectureSpec) => s.components.map((c) => c.id);
const comp = (s: ArchitectureSpec, id: string) => s.components.find((c) => c.id === id)!;

describe('azure-builder catalog', () => {
  it('is complete and every rate the engine needs is present', () => {
    expect(validateCatalog(catalog as any)).toEqual([]);
    expect(validateCatalog({ ...(catalog as any), iac: { ...(catalog as any).iac, avm: {} } })).toEqual(expect.arrayContaining(['component search module avm/res/search/search-service has no pinned version']));
    expect(validateCatalog({ ...(catalog as any), rates: { ...catalog.rates, models: {} } })).toEqual(expect.arrayContaining(['the chat model has no rate']));
  });
});

describe('designArchitecture - the sample landing zone (private, hub, shared monitoring)', () => {
  const spec = design();

  it('selects the RAG components and applies the environment rules (spec 8.3)', () => {
    expect(ids(spec)).toEqual(expect.arrayContaining(['aoai', 'search', 'storage', 'keyvault', 'identity', 'cae', 'app', 'log-analytics', 'app-insights', 'vnet', 'hub-vnet', 'private-endpoints', 'private-dns', 'bot']));
    expect(ids(spec)).not.toContain('apim'); // internal users, gateway left to the rules
    expect(ids(spec)).not.toContain('cosmos');
    expect(spec.private).toBe(true);
    expect(comp(spec, 'log-analytics')).toMatchObject({ reuseExisting: true, resourceId: sample.monitoring.logAnalyticsId });
    expect(comp(spec, 'hub-vnet')).toMatchObject({ reuseExisting: true, resourceId: sample.network.hubVnetId });
    expect(comp(spec, 'vnet').params.peerToHub).toBe(sample.network.hubVnetId);
    for (const id of ['aoai', 'search', 'storage', 'keyvault']) expect(comp(spec, id).params.publicNetworkAccess).toBe('Disabled');
    expect(comp(spec, 'private-dns').params).toEqual({
      reuse: ['privatelink.openai.azure.com', 'privatelink.blob.core.windows.net', 'privatelink.vaultcore.azure.net'],
      create: ['privatelink.cognitiveservices.azure.com', 'privatelink.search.windows.net'],
    });
  });

  it('sizes the deployment and the index from the use case', () => {
    expect(spec.sizing).toMatchObject({ monthlyRequests: 100000, peakTpm: 350000, chunks: 976563, searchTier: 'standard', searchPartitions: 1, searchReplicas: 2, deploymentSku: 'Standard', deploymentCapacity: 350 });
    // IN residency and centralindia is in no Azure OpenAI data zone -> regional Standard
    expect(spec.adrs.find((a) => a.id === 'ADR-03')!.decision).toContain('not in a data zone');
    expect(spec.warnings.join(' ')).toContain('only 130,000 is free in centralindia');
  });

  it('is internally consistent: the diagram can draw exactly the spec (spec 4.4 acceptance)', () => {
    expect(validateArchitecture(spec, sample.policy.allowedLocations)).toEqual([]);
    const known = new Set(ids(spec));
    for (const c of spec.connections) expect(known.has(c.from) && known.has(c.to)).toBe(true);
    for (const c of spec.components) expect(ZONES.map((z) => z.id)).toContain(c.zone);
    expect(spec.connections).toEqual(expect.arrayContaining([{ from: 'app', to: 'aoai', kind: 'private-endpoint' }, { from: 'search', to: 'aoai', kind: 'shared-private-link' }, { from: 'vnet', to: 'hub-vnet', kind: 'peering' }, { from: 'bot', to: 'app', kind: 'https' }]));
  });

  it('lists cost line items for every component and the assumptions behind them', () => {
    const { cost } = spec;
    expect(new Set(cost.lineItems.map((l) => l.component))).toEqual(new Set(ids(spec)));
    expect(cost.monthlyUsd).toBeCloseTo(cost.lineItems.reduce((t, l) => t + l.monthlyUsd, 0), 2);
    const chat = cost.lineItems.find((l) => l.item.startsWith('gpt-4o tokens'))!;
    expect(chat.monthlyUsd).toBeCloseTo(1375, 2); // 100k x (3000 x $2.50 + 500 x $10) / 1M x 1.10 regional
    expect(cost.lineItems.find((l) => l.component === 'search')!.monthlyUsd).toBeCloseTo(490.56, 2); // 2 x S1
    expect(cost.oneTimeUsd).toBeGreaterThan(0); // first full embedding
    expect(cost.assumptions.join(' ')).toMatch(/directional/i);
    expect(cost.overBudget).toBe(false);
  });

  it('applies mandatory and policy tags', () => {
    expect(spec.tags).toEqual({ useCaseId: 'uc-1', owner: 'architect@example.com', costCenter: 'HR-001', environment: 'prod', createdBy: 'ai-factory-builder' });
  });

  it('drafts ADRs only for decisions it made, and a summary that matches the spec', () => {
    expect(spec.adrs.map((a) => a.id)).toEqual(['ADR-01', 'ADR-02', 'ADR-03', 'ADR-04', 'ADR-05', 'ADR-06', 'ADR-07', 'ADR-08', 'ADR-09']);
    expect(spec.decisions).toHaveLength(spec.adrs.length);
    expect(spec.adrs.every((a) => a.status === 'proposed' && a.context && a.decision && a.consequences)).toBe(true);
    expect(spec.summary).toContain(`${spec.components.length} components`);
    expect(spec.summary.split(/\s+/).length).toBeLessThanOrEqual(120); // spec 10.3
    expect(design({}, { users: { ...hr.users, channels: ['web'] } }).adrs.map((a) => a.id)).not.toContain('ADR-09');
  });

  it('is deterministic', () => {
    expect(design()).toEqual(design());
  });
});

describe('designArchitecture - rules and toggles', () => {
  it('stays public when nothing requires private access, and uses Global Standard without residency', () => {
    const s = design({ profile: openProfile }, { data: [{ ...hr.data[0], classification: 'internal' }], constraints: { ...hr.constraints, dataResidency: null }, environment: 'dev' });
    expect(s.private).toBe(false);
    expect(ids(s)).not.toEqual(expect.arrayContaining(['vnet']));
    expect(ids(s)).not.toContain('private-endpoints');
    expect(comp(s, 'aoai').params.publicNetworkAccess).toBe('Enabled');
    expect(comp(s, 'log-analytics').reuseExisting).toBe(false);
    expect(s.sizing).toMatchObject({ deploymentSku: 'GlobalStandard', searchTier: 'basic', searchPartitions: 2, searchReplicas: 1 });
    expect(validateArchitecture(s, [])).toEqual([]);
  });

  it('hosts the API internal-only when every caller is inside the network', () => {
    const s = design({}, { users: { ...hr.users, channels: ['web'] } });
    expect(comp(s, 'app').params.ingress).toBe('internal');
    expect(comp(s, 'cae').params.internal).toBe(true);
  });

  it('goes private for personal data even when policy allows public access (spec 11.1)', () => {
    const s = design({ profile: openProfile }, { data: [{ ...hr.data[0], classification: 'internal', containsPersonalData: true }] });
    expect(s.private).toBe(true);
    expect(ids(s)).not.toContain('hub-vnet');
  });

  it('recommends provisioned throughput above the threshold, and the architect can override it', () => {
    const busy = { users: { ...hr.users, peakConcurrent: 300 } }; // 525k TPM
    expect(design({}, busy).sizing).toMatchObject({ deploymentSku: 'ProvisionedManaged', deploymentCapacity: 210 });
    expect(design({ options: { ...DEFAULT_OPTIONS, deployment: 'payg' } }, busy).sizing.deploymentSku).toBe('Standard');
    const forced = design({ options: { ...DEFAULT_OPTIONS, deployment: 'ptu' } });
    expect(forced.sizing).toMatchObject({ deploymentSku: 'ProvisionedManaged', deploymentCapacity: 140 });
    expect(forced.warnings.join(' ')).toContain('below the 400,000 TPM threshold');
    expect(forced.cost.modelOptions.ptuMonthlyUsd).toBeGreaterThan(forced.cost.modelOptions.paygMonthlyUsd);
  });

  it('adds the AI gateway for external users or on request, and chat history on request', () => {
    expect(ids(design({}, { users: { ...hr.users, type: 'external' } }))).toContain('apim');
    const s = design({ options: { apiGateway: true, chatHistory: true, deployment: 'auto' } });
    expect(ids(s)).toEqual(expect.arrayContaining(['apim', 'cosmos']));
    expect(comp(s, 'private-endpoints').params.targets).toContain('cosmos');
    expect((comp(s, 'private-dns').params.create as string[])).toContain('privatelink.documents.azure.com');
    expect(s.connections).toEqual(expect.arrayContaining([{ from: 'bot', to: 'apim', kind: 'https' }, { from: 'apim', to: 'app', kind: 'https' }]));
    expect(ids(design({ options: { ...DEFAULT_OPTIONS, apiGateway: false } }, { users: { ...hr.users, type: 'external' } }))).not.toContain('apim');
  });

  it('uses a data zone deployment when residency allows it, and respects denied SKUs', () => {
    const eu = { profile: { ...openProfile }, connection: { region: 'westeurope', deploymentModel: 'centralised' } };
    expect(design(eu, { constraints: { ...hr.constraints, regions: [], dataResidency: 'EU' } }).sizing.deploymentSku).toBe('DataZoneStandard');
    const denied = design({ ...eu, profile: { ...openProfile, policy: { ...openProfile.policy, deniedSkus: ['DataZoneStandard'] } } }, { constraints: { ...hr.constraints, regions: [], dataResidency: 'EU' } });
    expect(denied.sizing.deploymentSku).toBe('Standard');
    expect(denied.warnings.join(' ')).toContain('Policy denies the DataZoneStandard');
  });

  it('flags tags required by policy that have no value, and an estimate over budget', () => {
    const s = design({ profile: { ...sample, policy: { ...sample.policy, requiredTags: ['owner', 'dataOwner'] } } }, { constraints: { ...hr.constraints, monthlyBudgetUsd: 500 } });
    expect(s.tags.dataOwner).toBeNull();
    expect(s.warnings.join(' ')).toContain('dataOwner has no value yet (required by policy)');
    expect(s.cost.overBudget).toBe(true);
    expect(s.warnings.join(' ')).toContain('over the use case budget');
  });

  it('refuses patterns the MVP cannot design', () => {
    expect(() => design({}, { pattern: { ...hr.pattern, id: 'predictive-ml' } })).toThrow(ArchitectureError);
  });
});

describe('chooseRegion (rule: restrict to allowed locations)', () => {
  it('keeps the target when allowed, otherwise picks the first allowed region, and refuses when none fits', () => {
    expect(chooseRegion(['centralindia'], ['centralindia', 'southindia'], 'centralindia').region).toBe('centralindia');
    expect(chooseRegion(['southindia'], ['centralindia', 'southindia'], 'centralindia').region).toBe('southindia');
    expect(chooseRegion([], [], 'eastus').region).toBe('eastus');
    expect(() => chooseRegion(['eastus'], ['centralindia'], 'eastus')).toThrow('No region satisfies');
  });

  it('never places the design in a region the policy disallows', () => {
    const s = design({ connection: { region: 'westeurope', deploymentModel: 'hub_and_spoke' } }, { constraints: { ...hr.constraints, regions: [] } });
    expect(sample.policy.allowedLocations).toContain(s.region);
    expect(s.warnings.join(' ')).toContain('westeurope is not allowed');
  });
});
