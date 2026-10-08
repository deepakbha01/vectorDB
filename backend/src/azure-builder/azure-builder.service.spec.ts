import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService, permissionFor } from './azure-builder.service';
import { AzureRole, ConnectionSource, DeploymentModel, ProfileSource, ResourceGroupMode } from './azure-builder.enums';

/** A tiny in-memory stand-in for a TypeORM repository: filters on the project and any plain field; newest first (by version, else insertion). */
function memoryRepo() {
  const rows: any[] = [];
  const matching = (where: any) =>
    rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.project.id === where.project.id && Object.entries(where).every(([k, v]) => k === 'project' || r[k] === v))
      .sort((a, b) => (b.r.version ?? 0) - (a.r.version ?? 0) || b.i - a.i)
      .map(({ r }) => r);
  return {
    rows,
    create: (x: any) => ({ ...x }),
    save: async (x: any) => { const saved = { id: `id-${rows.length + 1}`, createdAt: new Date(), ...x }; rows.push(saved); return saved; },
    count: async ({ where }: any) => matching(where).length,
    find: async ({ where }: any) => matching(where),
    findOne: async ({ where }: any) => matching(where)[0] ?? null,
  };
}

const user = { id: 'u1', email: 'architect@example.com', role: 'architect' } as any;
const P = 'project-1';
const connectDto = {
  tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', subscriptionId: '11111111-2222-4333-8444-555555555555', resourceGroup: 'rg-uc-hr-dev',
  resourceGroupMode: ResourceGroupMode.NEW, region: 'CentralIndia', deploymentModel: DeploymentModel.HUB_AND_SPOKE, role: AzureRole.CONTRIBUTOR,
};

function setup(discovery: any = null) {
  const connections = memoryRepo();
  const profiles = memoryRepo();
  const useCases = memoryRepo();
  const architectures = memoryRepo();
  const iacBundles = memoryRepo();
  const whatIfs = memoryRepo();
  const approvals = memoryRepo();
  const projects = { findOne: jest.fn().mockResolvedValue({ id: P, name: 'HR Policy Assistant', businessUseCase: 'Employees ask HR policy questions and get grounded answers with citations from the policy handbook.' }) };
  const discoveryService = { getLatest: jest.fn().mockResolvedValue(discovery ? { assessment: discovery } : null) };
  const service = new AzureBuilderService(connections as any, profiles as any, useCases as any, architectures as any, iacBundles as any, whatIfs as any, approvals as any, projects as any, discoveryService as any);
  return { service, connections, profiles, useCases, architectures, iacBundles, whatIfs, approvals, projects };
}

const intake = {
  name: 'HR policy assistant',
  business: { problem: 'Employees cannot find answers in 400 HR policy documents and raise tickets instead', kpis: ['Deflect 30% of HR tickets'], sponsor: 'CHRO', costCenter: 'HR-001' },
  users: { type: 'internal' as const, count: 5000, peakConcurrent: 200, channels: ['web' as const, 'teams' as const] },
  data: [{ source: 'SharePoint HR site', format: 'pdf/docx', volumeGb: 20, classification: 'confidential' as const, containsPersonalData: false, refresh: 'daily' as const }],
  constraints: { regions: ['Central India'], dataResidency: 'IN', compliance: [], latencyMs: 3000, availability: '99.9', monthlyBudgetUsd: 3000 },
  environment: 'dev' as const,
};

describe('AzureBuilderService', () => {
  it('Phase 0: records a declared connection with its permission level and no credentials', async () => {
    const { service, projects } = setup();
    const c = await service.connect(P, user, { ...connectDto });
    expect(projects.findOne).toHaveBeenCalledWith(P, user); // access enforced
    expect(c).toMatchObject({ version: 1, active: true, source: ConnectionSource.DECLARED, region: 'centralindia' });
    expect(c.permission).toMatchObject({ canDesign: true, canDeploy: true, verified: false });
    expect(Object.keys(c).some((k) => /token|secret|password|key/i.test(k))).toBe(false);
  });

  it('Phase 0: a Reader can design but not deploy', () => {
    const p = permissionFor(AzureRole.READER, ConnectionSource.DECLARED);
    expect(p).toMatchObject({ canDesign: true, canDeploy: false });
    expect(p.note).toContain('deployment is blocked');
    expect(permissionFor(AzureRole.UNKNOWN, ConnectionSource.DECLARED).canDeploy).toBe(false);
    expect(permissionFor(AzureRole.OWNER, ConnectionSource.LIVE).note).not.toContain('Declared');
  });

  it('Phase 0: disconnect keeps history and requires an active connection', async () => {
    const { service, connections } = setup();
    await expect(service.disconnect(P, user)).rejects.toBeInstanceOf(BadRequestException);
    await service.connect(P, user, { ...connectDto });
    await service.disconnect(P, user);
    expect(connections.rows.map((r) => [r.version, r.active])).toEqual([[1, true], [2, false]]);
    expect((await service.getState(P, user)).connection).toBeNull();
  });

  it('Phase 1: requires a connection, then builds a versioned profile from the sample', async () => {
    const { service } = setup();
    await expect(service.discover(P, user, { source: ProfileSource.SAMPLE })).rejects.toThrow('Connect a target subscription');
    await service.connect(P, user, { ...connectDto });
    const p = await service.discover(P, user, { source: ProfileSource.SAMPLE });
    expect(p).toMatchObject({ version: 1, connectionVersion: 1, source: ProfileSource.SAMPLE });
    expect(p.constraints.privateEndpointsRequired).toBe(true);
    expect(p.problems[0]).toContain('Sample environment');
    const state = await service.getState(P, user);
    expect(state.environmentProfile?.id).toBe(p.id);
    expect(state.profileStale).toBe(false);
  });

  it('Phase 1: reads pasted Resource Graph output plus form policy, and rejects bad input clearly', async () => {
    const { service } = setup();
    await service.connect(P, user, { ...connectDto });
    const pasted = JSON.stringify({ data: [{ id: `/subscriptions/${connectDto.subscriptionId}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet-hub`, name: 'vnet-hub', type: 'microsoft.network/virtualnetworks', location: 'centralindia', addressSpace: ['10.0.0.0/16'] }] });
    const p = await service.discover(P, user, { source: ProfileSource.RESOURCE_GRAPH, resourceGraph: pasted, form: { allowedLocations: ['centralindia'], requiredTags: ['owner'] } });
    expect(p.profile.subscriptionId).toBe(connectDto.subscriptionId);
    expect(p.profile.network.hubVnetId).toContain('vnet-hub');
    expect(p.constraints.targetRegionAllowed).toBe(true);
    await expect(service.discover(P, user, { source: ProfileSource.RESOURCE_GRAPH })).rejects.toThrow('Paste the Resource Graph output');
    await expect(service.discover(P, user, { source: ProfileSource.RESOURCE_GRAPH, resourceGraph: 'not json' })).rejects.toThrow('not valid JSON');
    await expect(service.discover(P, user, { source: ProfileSource.FORM, form: { secureScore: 150 } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marks the profile stale when the connection changes (e.g. a new region)', async () => {
    const { service } = setup();
    await service.connect(P, user, { ...connectDto });
    await service.discover(P, user, { source: ProfileSource.SAMPLE });
    await service.connect(P, user, { ...connectDto, region: 'southindia' });
    expect((await service.getState(P, user)).profileStale).toBe(true);
  });
});

describe('AzureBuilderService - Phase 2 use case intake', () => {
  it('classifies the answers, stores a versioned UseCaseSpec, and shows it in the state', async () => {
    const { service } = setup();
    const v1 = await service.submitUseCase(P, user, intake);
    expect(v1.version).toBe(1);
    expect(v1.spec.pattern).toMatchObject({ id: 'rag-assistant', classifiedAs: 'rag-assistant', overriddenBy: null, supportedInMvp: true, riskClass: 'medium' });
    expect(v1.spec.constraints.regions).toEqual(['centralindia']); // normalised
    expect(v1.spec.owner).toBe(user.email);
    expect(v1.classification.classifier).toBe('deterministic-keyword-v1');
    const v2 = await service.submitUseCase(P, user, { ...intake, business: { ...intake.business, kpis: [] } });
    expect(v2.version).toBe(2);
    expect(v2.spec.pattern.missingInfo).toContain('At least one measurable KPI');
    expect((await service.getState(P, user)).useCase?.version).toBe(2);
    expect((await service.useCaseHistory(P, user)).map((u) => u.version)).toEqual([2, 1]);
  });

  it('rejects answers that break business rules', async () => {
    const { service } = setup();
    await expect(service.submitUseCase(P, user, { ...intake, users: { ...intake.users, peakConcurrent: 9000 } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records an override with who and why, keeping the classifier output', async () => {
    const { service } = setup();
    await expect(service.overridePattern(P, user, { pattern: 'agentic-workflow', reason: 'Needs to raise tickets in ServiceNow' })).rejects.toThrow('Complete the use case intake');
    await service.submitUseCase(P, user, intake);
    const o = await service.overridePattern(P, user, { pattern: 'agentic-workflow', reason: 'Needs to raise tickets in ServiceNow' });
    expect(o.version).toBe(2);
    expect(o.spec.pattern).toMatchObject({ id: 'agentic-workflow', classifiedAs: 'rag-assistant', overriddenBy: user.email, overrideReason: 'Needs to raise tickets in ServiceNow', supportedInMvp: false });
    expect(o.classification.pattern).toBe('rag-assistant');
  });

  it('prefills the wizard from the project, its connection and Evectorize Discovery, saying where each value came from', async () => {
    const { service } = setup({ environment: 'production', concurrentUsers: 150, documentCount: 4000, avgDocumentSizeKb: 512, containsPii: true, regulatoryRequirements: 'DPDP, ISO 27001', targetP95LatencyMs: 2500, availabilityTargetPercent: 99.9, monthlyBudgetUsd: 4000 });
    await service.connect(P, user, { ...connectDto });
    const p = await service.intakePrefill(P, user);
    expect(p.answers).toMatchObject({ name: 'HR Policy Assistant', environment: 'prod' });
    expect(p.answers.business.problem).toContain('HR policy questions');
    expect(p.answers.constraints).toMatchObject({ regions: ['centralindia'], compliance: ['DPDP', 'ISO 27001'], latencyMs: 2500, monthlyBudgetUsd: 4000 });
    expect(p.answers.data[0]).toMatchObject({ classification: 'confidential', containsPersonalData: true });
    expect(p.answers.data[0].volumeGb).toBeCloseTo(1.95, 2); // 4000 x 512 KB
    expect(p.sources['users.count']).toContain('confirm');
    expect(p.patterns.map((x: any) => x.id)).toContain('rag-assistant');
  });

  it('prefills with blanks when there is no Discovery or connection yet', async () => {
    const { service } = setup();
    const p = await service.intakePrefill(P, user);
    expect(p.answers.data).toEqual([]);
    expect(p.answers.constraints.regions).toEqual([]);
  });
});

describe('AzureBuilderService - Phase 3 architect', () => {
  it('needs a use case, a connection and a current Environment Profile first', async () => {
    const { service } = setup();
    await expect(service.generateArchitecture(P, user, {})).rejects.toThrow('Complete the use case intake');
    await service.submitUseCase(P, user, intake);
    await expect(service.generateArchitecture(P, user, {})).rejects.toThrow('Connect a target subscription');
    await service.connect(P, user, { ...connectDto });
    await expect(service.generateArchitecture(P, user, {})).rejects.toThrow('Run Discover');
    await service.discover(P, user, { source: ProfileSource.SAMPLE });
    await service.connect(P, user, { ...connectDto, region: 'southindia' });
    await expect(service.generateArchitecture(P, user, {})).rejects.toThrow('connection changed');
  });

  it('designs a versioned architecture from the latest inputs, and marks it stale when they change', async () => {
    const { service } = setup();
    await service.connect(P, user, { ...connectDto });
    await service.discover(P, user, { source: ProfileSource.SAMPLE });
    await service.submitUseCase(P, user, intake);
    const a1 = await service.generateArchitecture(P, user, {});
    expect(a1).toMatchObject({ version: 1, useCaseVersion: 1, profileVersion: 1 });
    expect(a1.spec).toMatchObject({ region: 'centralindia', private: true, options: { apiGateway: null, chatHistory: false, deployment: 'auto' } });
    const a2 = await service.generateArchitecture(P, user, { apiGateway: true, chatHistory: true });
    expect(a2.version).toBe(2);
    expect(a2.spec.components.map((c) => c.id)).toEqual(expect.arrayContaining(['apim', 'cosmos']));
    expect(a2.spec.cost.monthlyUsd).toBeGreaterThan(a1.spec.cost.monthlyUsd);
    expect((await service.getState(P, user)).architectureStale).toBe(false);
    await service.submitUseCase(P, user, { ...intake, users: { ...intake.users, count: 8000 } });
    expect((await service.getState(P, user)).architectureStale).toBe(true);
    expect((await service.architectureHistory(P, user)).map((a) => a.version)).toEqual([2, 1]);
  });

  it('turns rules-engine refusals into clear 400s', async () => {
    const { service } = setup();
    await service.connect(P, user, { ...connectDto });
    await service.discover(P, user, { source: ProfileSource.SAMPLE });
    await service.submitUseCase(P, user, intake);
    await service.overridePattern(P, user, { pattern: 'predictive-ml', reason: 'It is really a forecasting problem' });
    await expect(service.generateArchitecture(P, user, {})).rejects.toBeInstanceOf(BadRequestException);
    await service.submitUseCase(P, user, { ...intake, constraints: { ...intake.constraints, regions: ['eastus'] } });
    await expect(service.generateArchitecture(P, user, {})).rejects.toThrow('No region satisfies');
  });
});

describe('AzureBuilderService - Phase 4 generate IaC', () => {
  const ready = async () => {
    const ctx = setup();
    await ctx.service.connect(P, user, { ...connectDto });
    await ctx.service.discover(P, user, { source: ProfileSource.SAMPLE });
    await ctx.service.submitUseCase(P, user, intake);
    return ctx;
  };

  it('needs a current architecture first', async () => {
    const { service } = await ready();
    await expect(service.generateIac(P, user, {})).rejects.toThrow('Design the architecture');
    await service.generateArchitecture(P, user, {});
    await service.submitUseCase(P, user, { ...intake, users: { ...intake.users, count: 9000 } });
    await expect(service.generateIac(P, user, {})).rejects.toThrow('design it again');
  });

  it('generates a versioned bundle (validation skipped without a Bicep CLI), zips it and tracks staleness', async () => {
    const before = process.env.AZURE_BUILDER_BICEP_PATH;
    delete process.env.AZURE_BUILDER_BICEP_PATH;
    try {
      const { service } = await ready();
      await service.generateArchitecture(P, user, {});
      const b = await service.generateIac(P, user, {});
      expect(b).toMatchObject({ version: 1, architectureVersion: 1, workload: 'hrpoliassi', generator: 'bicep-avm-v1' });
      expect(b.validation.status).toBe('skipped');
      expect(b.files.map((f) => f.path)).toContain('infra/main.bicep');
      expect(b.files.find((f) => f.path === 'infra/params/prod.bicepparam')!.content).toContain("param environment = 'prod'");
      const named = await service.generateIac(P, user, { workload: 'hrpolicy' });
      expect(named.files.find((f) => f.path === 'infra/params/dev.bicepparam')!.content).toContain("param workload = 'hrpolicy'");

      const state = await service.getState(P, user);
      expect(state.iacBundle).toMatchObject({ version: 2 });
      expect((state.iacBundle as any).files).toBeUndefined();
      expect(state.iacStale).toBe(false);
      await service.generateArchitecture(P, user, { chatHistory: true });
      expect((await service.getState(P, user)).iacStale).toBe(true);

      const zip = await service.iacZip(P, user, 1);
      expect(zip.filename).toBe(`${b.root}-v1.zip`);
      expect(zip.buffer.readUInt32LE(0)).toBe(0x04034b50);
      await expect(service.iacZip(P, user, 9)).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      if (before !== undefined) process.env.AZURE_BUILDER_BICEP_PATH = before;
    }
  });
});

describe('AzureBuilderService - Phase 5 validate & approve', () => {
  // Unit tests: never run the Bicep CLI, even when AZURE_BUILDER_BICEP_PATH is set for the compile tests.
  const bicepPath = process.env.AZURE_BUILDER_BICEP_PATH;
  beforeAll(() => { delete process.env.AZURE_BUILDER_BICEP_PATH; });
  afterAll(() => { if (bicepPath !== undefined) process.env.AZURE_BUILDER_BICEP_PATH = bicepPath; });
  const other = { id: 'u2', email: 'approver@example.com', role: 'architect' } as any;
  const inputs = {
    dev: { vnetAddressPrefix: '10.20.0.0/22', privateDnsZoneResourceGroupId: `/subscriptions/${connectDto.subscriptionId}/resourceGroups/rg-hub-dns` },
    test: { vnetAddressPrefix: '10.20.4.0/22', privateDnsZoneResourceGroupId: `/subscriptions/${connectDto.subscriptionId}/resourceGroups/rg-hub-dns` },
    prod: { vnetAddressPrefix: '10.20.8.0/22', privateDnsZoneResourceGroupId: `/subscriptions/${connectDto.subscriptionId}/resourceGroups/rg-hub-dns`, containerImage: 'myacr.azurecr.io/assistant-api:1.0.0' },
  };
  const ready = async (withInputs = true) => {
    const ctx = setup();
    await ctx.service.connect(P, user, { ...connectDto });
    await ctx.service.discover(P, user, { source: ProfileSource.SAMPLE });
    await ctx.service.submitUseCase(P, user, intake);
    await ctx.service.generateArchitecture(P, user, {});
    const bundle = await ctx.service.generateIac(P, user, withInputs ? { inputs } : {});
    return { ...ctx, bundle };
  };

  it('writes the inputs into the parameter files, validates them, and carries them over', async () => {
    const { service, bundle } = await ready();
    expect(bundle.files.find((f) => f.path === 'infra/params/prod.bicepparam')!.content).toContain("param vnetAddressPrefix = '10.20.8.0/22'");
    expect(bundle.missingInputs).toEqual({ dev: [], test: [], prod: [] });
    await expect(service.generateIac(P, user, { inputs: { dev: { vnetAddressPrefix: '10.0.0.0/22' } } })).rejects.toThrow(BadRequestException); // overlaps the sample hub (10.0.0.0/16)
    const again = await service.generateIac(P, user, {});
    expect(again.inputs).toEqual(bundle.inputs);
  });

  it('blocks approval until a what-if of this bundle passes, then records an immutable, hash-bound decision', async () => {
    const { service } = await ready(false);
    await expect(service.decide(P, other, { environment: 'dev', decision: 'approved' })).rejects.toThrow('Run a what-if');
    const blocked = await service.runWhatIf(P, user, { environment: 'dev', source: 'planned' });
    expect(blocked.report.approvable).toBe(false);
    expect(blocked.report.blocking.join(' ')).toContain('vnetAddressPrefix is blank in dev.bicepparam');
    await expect(service.decide(P, other, { environment: 'dev', decision: 'approved' })).rejects.toThrow('Approval is blocked');

    await service.generateIac(P, user, { inputs });
    await expect(service.decide(P, other, { environment: 'dev', decision: 'approved' })).rejects.toThrow('Run a what-if'); // new bundle, new hash
    const w = await service.runWhatIf(P, user, { environment: 'dev', source: 'planned' });
    expect(w.report).toMatchObject({ approvable: true, iacVersion: 2, riskClass: 'medium', raiRequired: false });
    expect(w.report.risks.join(' ')).toContain('offline plan');
    expect(w.report.risks.join(' ')).not.toContain('needs an address range'); // answered by the dev input
    const a = await service.decide(P, other, { environment: 'dev', decision: 'approved', comments: 'Looks right' });
    expect(a).toMatchObject({ decision: 'approved', iacVersion: 2, iacHash: w.iacHash, whatIfId: w.id, evidence: 'offline-plan', approverEmail: 'approver@example.com' });
    expect((await service.approvalHistory(P, user)).length).toBe(1);
  });

  it('enforces separation of duties for prod and requires a reason to reject', async () => {
    const { service } = await ready();
    await service.runWhatIf(P, user, { environment: 'prod', source: 'planned' });
    await expect(service.decide(P, user, { environment: 'prod', decision: 'approved' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.decide(P, user, { environment: 'prod', decision: 'rejected', comments: 'no' })).rejects.toThrow('Say why');
    expect((await service.decide(P, user, { environment: 'prod', decision: 'rejected', comments: 'Wait for the DPIA sign-off' })).decision).toBe('rejected');
    expect((await service.decide(P, other, { environment: 'prod', decision: 'approved' })).decision).toBe('approved');
  });

  it('requires the responsible-AI checklist for a high-risk use case', async () => {
    const ctx = setup();
    await ctx.service.connect(P, user, { ...connectDto });
    await ctx.service.discover(P, user, { source: ProfileSource.SAMPLE });
    await ctx.service.submitUseCase(P, user, { ...intake, users: { ...intake.users, type: 'external' } });
    await ctx.service.generateArchitecture(P, user, {});
    await ctx.service.generateIac(P, user, { inputs });
    const w = await ctx.service.runWhatIf(P, user, { environment: 'test', source: 'planned' });
    expect(w.report.raiRequired).toBe(true);
    await expect(ctx.service.decide(P, other, { environment: 'test', decision: 'approved', raiChecklist: ['content-safety'] })).rejects.toThrow('responsible-AI checklist');
    const all = ['content-safety', 'data-review', 'human-oversight', 'transparency', 'evaluation', 'incident'];
    expect((await ctx.service.decide(P, other, { environment: 'test', decision: 'approved', raiChecklist: all })).raiChecklist).toEqual(all);
  });

  it('reads a pasted ARM what-if and refuses one that does not belong to the connected target', async () => {
    const { service } = await ready();
    await expect(service.runWhatIf(P, user, { environment: 'dev', source: 'arm' })).rejects.toThrow('Paste the output');
    const w = await service.runWhatIf(P, user, { environment: 'dev', source: 'arm', result: JSON.stringify({ status: 'Succeeded', changes: [{ resourceId: '/subscriptions/x/resourceGroups/other/providers/Microsoft.Storage/storageAccounts/st1', changeType: 'Create', after: { location: 'centralindia' } }] }) });
    expect(w.report.approvable).toBe(false);
    expect(w.report.blocking.join(' ')).toContain('outside the connected target');
  });

  it('refuses to validate a bundle older than the design', async () => {
    const { service } = await ready();
    await service.generateArchitecture(P, user, { chatHistory: true });
    await expect(service.runWhatIf(P, user, { environment: 'dev', source: 'planned' })).rejects.toThrow('generate it again');
  });
});

describe('AzureBuilderEnabledGuard', () => {
  it('hides the endpoints unless AZURE_BUILDER_ENABLED is on', () => {
    const guard = (v?: string) => new AzureBuilderEnabledGuard({ get: (k: string) => (k === 'AZURE_BUILDER_ENABLED' ? v : undefined) } as unknown as ConfigService);
    expect(() => guard(undefined).canActivate()).toThrow(NotFoundException);
    expect(() => guard('false').canActivate()).toThrow(NotFoundException);
    expect(guard('true').canActivate()).toBe(true);
  });
});
