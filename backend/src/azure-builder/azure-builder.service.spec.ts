import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService, liveAzureConfig, permissionFor } from './azure-builder.service';
import { ArmError } from './arm-client';
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
  const deployments = memoryRepo();
  const projects = { findOne: jest.fn().mockResolvedValue({ id: P, name: 'HR Policy Assistant', businessUseCase: 'Employees ask HR policy questions and get grounded answers with citations from the policy handbook.' }) };
  const discoveryService = { getLatest: jest.fn().mockResolvedValue(discovery ? { assessment: discovery } : null) };
  const service = new AzureBuilderService(connections as any, profiles as any, useCases as any, architectures as any, iacBundles as any, whatIfs as any, approvals as any, deployments as any, projects as any, discoveryService as any);
  return { service, connections, profiles, useCases, architectures, iacBundles, whatIfs, approvals, deployments, projects };
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
    // The override survives the resubmitted intake; set the pattern back to the RAG assistant to reach the region rule.
    await service.overridePattern(P, user, { pattern: 'rag-assistant', reason: 'Back to the RAG design' });
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

describe('AzureBuilderService - live Azure (Wave 6a)', () => {
  const TENANT = 'ef04bcd8-91ce-495c-9393-c645d394493c';
  const SUB = '51bfc241-927a-44b4-9dc8-2a3af25352b4';
  const token = (claims: Record<string, unknown> = {}) => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ aud: 'https://management.azure.com/', tid: TENANT, upn: 'architect@contoso.com', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
  };
  const liveDto = { subscriptionId: SUB, resourceGroup: 'evectorizeresoruces', resourceGroupMode: ResourceGroupMode.EXISTING, region: 'CentralIndia', deploymentModel: DeploymentModel.HUB_AND_SPOKE };
  const envBefore = { ...process.env };

  /** An ARM client answering the calls live Connect and Discover make. */
  function armReplies(overrides: { groupMissing?: boolean; tenantId?: string; perms?: unknown[] } = {}) {
    const answer = async (path: string): Promise<any> => {
      if (/permissions/.test(path)) return { value: overrides.perms ?? [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write'] }] };
      if (/\/locations\?/.test(path)) return { value: [{ name: 'centralindia' }] };
      if (/resourcegroups\/[^/?]+\?/.test(path)) {
        if (overrides.groupMissing) throw new ArmError(404, 'ResourceGroupNotFound', 'not found');
        return { location: 'centralindia' };
      }
      if (/ResourceGraph/.test(path)) return { data: [{ id: `/subscriptions/${SUB}/resourceGroups/rg-mon/providers/Microsoft.OperationalInsights/workspaces/log-1`, name: 'log-1', type: 'microsoft.operationalinsights/workspaces', location: 'centralindia' }] };
      if (/policyAssignments|usages/.test(path)) return { value: [] };
      if (/secureScores/.test(path)) throw new ArmError(404, 'NotFound', 'x');
      if (/\/subscriptions\/[^/]+\?/.test(path)) return { displayName: 'Evectorize Test', tenantId: overrides.tenantId ?? TENANT };
      if (/\/subscriptions\?/.test(path)) return { value: [{ subscriptionId: SUB, displayName: 'Evectorize Test', tenantId: TENANT, state: 'Enabled' }] };
      throw new Error(`unexpected ${path}`);
    };
    return { get: jest.fn(answer), post: jest.fn(answer), list: jest.fn(async (p: string) => (await answer(p)).value) } as any;
  }

  function liveSetup(overrides: Parameters<typeof armReplies>[0] = {}) {
    const s = setup();
    const arm = armReplies(overrides);
    const seen: string[] = [];
    s.service.armClientFor = (t) => { seen.push(t); return arm; };
    return { ...s, arm, seen };
  }

  beforeEach(() => {
    process.env.AZURE_BUILDER_ENTRA_CLIENT_ID = 'ba6bfea9-3b98-45bf-bcc5-a9929849f229';
    process.env.AZURE_BUILDER_ENTRA_TENANT_ID = TENANT;
  });
  afterEach(() => { process.env = { ...envBefore }; });

  it('exposes the Entra app registration only when both IDs are configured', () => {
    expect(liveAzureConfig()).toEqual({ enabled: true, clientId: 'ba6bfea9-3b98-45bf-bcc5-a9929849f229', tenantId: TENANT, scopes: ['https://management.azure.com/user_impersonation'] });
    expect(liveAzureConfig({ AZURE_BUILDER_ENTRA_CLIENT_ID: 'not-a-guid', AZURE_BUILDER_ENTRA_TENANT_ID: TENANT }).enabled).toBe(false);
  });

  it('Phase 0 live: verifies the target and records the role Azure reports, never the token', async () => {
    const { service, connections, seen } = liveSetup();
    const t = token();
    const c = await service.connectLive(P, user, t, { ...liveDto });
    expect(seen).toEqual([t]);
    expect(c).toMatchObject({ source: ConnectionSource.LIVE, tenantId: TENANT, subscriptionName: 'Evectorize Test', region: 'centralindia', role: AzureRole.CONTRIBUTOR, azureUser: 'architect@contoso.com' });
    expect(c.permission).toMatchObject({ verified: true, canDeploy: true, canAssignRoles: false });
    expect(c.permission.note).toContain('Role Based Access Control Administrator');
    expect(JSON.stringify(connections.rows)).not.toContain(t);
  });

  it('Phase 0 live: asks for an Azure sign-in (400, not 401) when the token is missing, foreign or expired', async () => {
    const { service } = liveSetup();
    for (const t of [undefined, token({ tid: '00000000-0000-4000-8000-000000000000' }), token({ exp: 1 })]) {
      const err = await service.connectLive(P, user, t, { ...liveDto }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ errorCode: 'AZURE_SIGN_IN_REQUIRED' });
    }
  });

  it('Phase 0 live: refuses when live Azure is not configured on the server', async () => {
    delete process.env.AZURE_BUILDER_ENTRA_CLIENT_ID;
    const { service } = liveSetup();
    await expect(service.connectLive(P, user, token(), { ...liveDto })).rejects.toThrow('not configured');
  });

  it('Phase 0 live: checks the resource group mode against what exists, and the subscription tenant', async () => {
    await expect(liveSetup({ groupMissing: true }).service.connectLive(P, user, token(), { ...liveDto })).rejects.toThrow('was not found');
    await expect(liveSetup().service.connectLive(P, user, token(), { ...liveDto, resourceGroupMode: ResourceGroupMode.NEW })).rejects.toThrow('already exists');
    await expect(liveSetup({ tenantId: '00000000-0000-4000-8000-000000000000' }).service.connectLive(P, user, token(), { ...liveDto })).rejects.toThrow('belongs to tenant');
  });

  it('Phase 0 live: an Azure 403 surfaces as Forbidden with Azure\'s message', async () => {
    const { service, arm } = liveSetup();
    arm.get.mockRejectedValueOnce(new ArmError(403, 'AuthorizationFailed', 'The client does not have authorization'));
    await expect(service.connectLive(P, user, token(), { ...liveDto })).rejects.toThrow(ForbiddenException);
  });

  it('Phase 1 live: needs a live connection, then builds the profile from the subscription', async () => {
    const { service } = liveSetup();
    await service.connect(P, user, { ...connectDto });
    await expect(service.discover(P, user, { source: ProfileSource.LIVE }, token())).rejects.toThrow('needs a live connection');
    await service.connectLive(P, user, token(), { ...liveDto });
    const p = await service.discover(P, user, { source: ProfileSource.LIVE }, token());
    expect(p).toMatchObject({ source: ProfileSource.LIVE, connectionVersion: 2 });
    expect(p.profile.subscriptionId).toBe(SUB);
    expect(p.profile.monitoring.logAnalyticsId).toContain('/workspaces/log-1');
    expect(p.problems).toContain('Defender for Cloud secure score is not available for this subscription or user.');
  });

  it('lists subscriptions for the signed-in user', async () => {
    const { service } = liveSetup();
    await expect(service.liveSubscriptions(P, user, token())).resolves.toEqual([{ subscriptionId: SUB, displayName: 'Evectorize Test', tenantId: TENANT, state: 'Enabled' }]);
  });
});

describe('AzureBuilderService - live what-if and Deploy (Wave 6b)', () => {
  const TENANT = 'ef04bcd8-91ce-495c-9393-c645d394493c';
  const SUB = '51bfc241-927a-44b4-9dc8-2a3af25352b4';
  const RG = 'evectorizeresoruces';
  const other = { id: 'u2', email: 'approver@example.com', role: 'architect' } as any;
  const token = () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ aud: 'https://management.azure.com/', tid: TENANT, upn: 'architect@contoso.com', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  };
  const inputs = { dev: { vnetAddressPrefix: '10.20.0.0/22', privateDnsZoneResourceGroupId: `/subscriptions/${SUB}/resourceGroups/rg-hub-dns` } };
  const stackId = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deploymentStacks/azb-hrpoliassi-dev`;
  const envBefore = { ...process.env };

  /** Answers the ARM calls of live Connect, what-if, deny-setting check, stack PUT and stack GET. */
  function fakeArm(opts: { perms?: unknown[]; stack?: unknown } = {}) {
    const perms = opts.perms ?? [{ actions: ['*'], notActions: [] }];
    const answer = async (path: string): Promise<any> => {
      if (/permissions/.test(path)) return { value: perms };
      if (/\/locations\?/.test(path)) return { value: [{ name: 'centralindia' }] };
      if (/deploymentStacks/.test(path)) return opts.stack ?? { id: stackId, properties: { provisioningState: 'succeeded', outputs: { apiUrl: { type: 'String', value: 'https://api' } }, resources: [{ id: `${RG}/search` }] } };
      if (/resourcegroups\/[^/?]+\?/.test(path)) return { location: 'centralindia' };
      if (/\/subscriptions\/[^/]+\?/.test(path)) return { displayName: 'Evectorize Test', tenantId: TENANT };
      throw new Error(`unexpected ${path}`);
    };
    return {
      get: jest.fn(answer),
      list: jest.fn(async (p: string) => (await answer(p)).value),
      put: jest.fn(async () => ({ id: stackId, properties: { provisioningState: 'deploying' } })),
      postLongRunning: jest.fn(async () => ({
        status: 'Succeeded',
        properties: { changes: [{ resourceId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Search/searchServices/srch-hr`, changeType: 'Create', after: { location: 'centralindia', tags: {} } }] },
      })),
    } as any;
  }

  /** A live-connected project with a dev bundle ready for a what-if; Bicep compilation is stubbed. */
  async function liveReady(opts: Parameters<typeof fakeArm>[0] = {}) {
    const ctx = setup();
    const arm = fakeArm(opts);
    ctx.service.armClientFor = () => arm;
    const compile = jest.fn().mockResolvedValue({ template: { resources: [] }, parameters: { environment: { value: 'dev' } }, tool: 'Bicep CLI version 0.48.1' });
    (ctx.service as any).compile = compile;
    await ctx.service.connectLive(P, user, token(), { subscriptionId: SUB, resourceGroup: RG, resourceGroupMode: ResourceGroupMode.EXISTING, region: 'centralindia', deploymentModel: DeploymentModel.HUB_AND_SPOKE });
    await ctx.service.discover(P, user, { source: ProfileSource.SAMPLE });
    await ctx.service.submitUseCase(P, user, intake);
    await ctx.service.generateArchitecture(P, user, {});
    await ctx.service.generateIac(P, user, { inputs });
    // What ARM would answer for this bundle: the planned changes (new resources created, reused hub resources unchanged).
    const plan = await ctx.service.runWhatIf(P, user, { environment: 'dev', source: 'planned' });
    const armResult = { status: 'Succeeded', changes: plan.changes.map((c) => ({ resourceId: c.resourceId, changeType: c.changeType, after: { location: c.location ?? 'centralindia', tags: {} } })) };
    arm.postLongRunning.mockResolvedValue({ status: armResult.status, properties: { changes: armResult.changes } });
    return { ...ctx, arm, compile, armResult };
  }

  beforeEach(() => {
    process.env.AZURE_BUILDER_ENTRA_CLIENT_ID = 'ba6bfea9-3b98-45bf-bcc5-a9929849f229';
    process.env.AZURE_BUILDER_ENTRA_TENANT_ID = TENANT;
    delete process.env.AZURE_BUILDER_BICEP_PATH; // unit tests never run the Bicep CLI
  });
  afterEach(() => { process.env = { ...envBefore }; });

  it('Phase 5 live: compiles the environment, runs ARM what-if with the sign-in and records it as live ARM evidence', async () => {
    const { service, arm, compile } = await liveReady();
    const w = await service.runWhatIf(P, user, { environment: 'dev', source: 'live' }, token());
    expect(compile).toHaveBeenCalledWith(expect.any(Array), 'dev');
    expect(arm.postLongRunning).toHaveBeenCalledWith(expect.stringContaining(`/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/azb-hrpoliassi-dev-v1-whatif/whatIf`), expect.objectContaining({ properties: expect.objectContaining({ mode: 'Incremental' }) }));
    expect(w).toMatchObject({ source: 'arm', status: 'succeeded', report: { source: 'arm', armOrigin: 'live' } });
    expect(w.changes[0]).toMatchObject({ changeType: 'Create', owned: true });
  });

  it('Phase 5 live: needs a live connection and an Azure sign-in', async () => {
    const declared = setup();
    await declared.service.connect(P, user, { ...connectDto });
    await declared.service.discover(P, user, { source: ProfileSource.SAMPLE });
    await declared.service.submitUseCase(P, user, intake);
    await declared.service.generateArchitecture(P, user, {});
    await declared.service.generateIac(P, user, { inputs });
    await expect(declared.service.runWhatIf(P, user, { environment: 'dev', source: 'live' }, token())).rejects.toThrow('needs a live connection');
    const { service } = await liveReady();
    const err = await service.runWhatIf(P, user, { environment: 'dev', source: 'live' }, undefined).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ errorCode: 'AZURE_SIGN_IN_REQUIRED' });
  });

  it('Phase 6: deploys only an approval of this bundle that rests on a live what-if', async () => {
    const { service, armResult } = await liveReady();
    await expect(service.deploy(P, user, token(), { environment: 'dev' })).rejects.toThrow('is not approved for dev');

    await service.runWhatIf(P, user, { environment: 'dev', source: 'planned' });
    await service.decide(P, other, { environment: 'dev', decision: 'approved' });
    await expect(service.deploy(P, user, token(), { environment: 'dev' })).rejects.toThrow('rests on the offline what-if');

    const pasted = JSON.stringify(armResult);
    await service.runWhatIf(P, user, { environment: 'dev', source: 'arm', result: pasted });
    await service.decide(P, other, { environment: 'dev', decision: 'approved' });
    await expect(service.deploy(P, user, token(), { environment: 'dev' })).rejects.toThrow('rests on a pasted what-if');

    await service.runWhatIf(P, user, { environment: 'dev', source: 'live' }, token());
    await service.decide(P, other, { environment: 'dev', decision: 'rejected', comments: 'Wait for the network review' });
    await expect(service.deploy(P, user, token(), { environment: 'dev' })).rejects.toThrow('is not approved for dev'); // the latest decision counts
  });

  it('Phase 6: creates a Deployment Stack with deny settings, then follows it to success with its outputs', async () => {
    const { service, arm, deployments } = await liveReady();
    await service.runWhatIf(P, user, { environment: 'dev', source: 'live' }, token());
    await service.decide(P, other, { environment: 'dev', decision: 'approved' });
    const t = token();
    const d = await service.deploy(P, user, t, { environment: 'dev' });
    expect(arm.put).toHaveBeenCalledWith(
      expect.stringContaining(`/resourceGroups/${RG}/providers/Microsoft.Resources/deploymentStacks/azb-hrpoliassi-dev?`),
      expect.objectContaining({ properties: expect.objectContaining({ denySettings: { mode: 'denyDelete', applyToChildScopes: false }, actionOnUnmanage: expect.objectContaining({ resources: 'detach' }) }) }),
    );
    expect(d).toMatchObject({ environment: 'dev', state: 'running', denyMode: 'denyDelete', stackId, azureUser: 'architect@contoso.com', compiledWith: 'Bicep CLI version 0.48.1' });
    expect(JSON.stringify(deployments.rows)).not.toContain(t);
    await expect(service.deploy(P, user, token(), { environment: 'dev' })).rejects.toThrow('already running');

    const done = await service.refreshDeployment(P, user, token(), d.id);
    expect(done).toMatchObject({ state: 'succeeded', outputs: { apiUrl: 'https://api' }, resourceIds: [`${RG}/search`] });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect((await service.deploymentHistory(P, user))[0].state).toBe('succeeded');
  });

  it('Phase 6: without the deny-setting permission the stack has no deny settings; a failure keeps the failing resource and ARM message', async () => {
    const failed = {
      id: stackId,
      properties: {
        provisioningState: 'failed',
        error: { code: 'DeploymentFailed', message: 'At least one resource deployment operation failed.', details: [{ code: 'ResourceDeploymentFailure', target: `${RG}/providers/Microsoft.CognitiveServices/accounts/oai-hr`, message: 'x', details: [{ code: 'InsufficientQuota', message: 'This operation require 30 new capacity in quota Tokens Per Minute.' }] }] },
      },
    };
    const contributorPlusRbac = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Resources/deploymentStacks/manageDenySetting/action'] }, { actions: ['Microsoft.Authorization/roleAssignments/write'] }];
    const { service } = await liveReady({ perms: contributorPlusRbac, stack: failed });
    await service.runWhatIf(P, user, { environment: 'dev', source: 'live' }, token());
    await service.decide(P, other, { environment: 'dev', decision: 'approved' });
    const d = await service.deploy(P, user, token(), { environment: 'dev' });
    expect(d.denyMode).toBe('none');
    const done = await service.refreshDeployment(P, user, token(), d.id);
    expect(done.state).toBe('failed');
    expect(done.errors).toEqual([{ code: 'InsufficientQuota', message: 'This operation require 30 new capacity in quota Tokens Per Minute.', resource: `${RG}/providers/Microsoft.CognitiveServices/accounts/oai-hr` }]);
  });

  it('Phase 6: a Reader cannot deploy', async () => {
    const { service } = await liveReady({ perms: [{ actions: ['*/read'] }] });
    await expect(service.deploy(P, user, token(), { environment: 'dev' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AzureBuilderService - pattern override and a resubmitted intake', () => {
  it('keeps the override while the classifier still gives the result that was overridden, and drops it when the answers change that', async () => {
    const { service } = setup();
    const copilot = { ...intake, name: 'Customer chat', business: { ...intake.business, problem: 'A customer service chatbot to deflect helpdesk conversations' } };
    expect((await service.submitUseCase(P, user, copilot)).spec.pattern.id).toBe('conversational-copilot');
    await service.overridePattern(P, user, { pattern: 'rag-assistant', reason: 'Answers come from the knowledge base' });

    const again = await service.submitUseCase(P, user, { ...copilot, business: { ...copilot.business, sponsor: 'COO' } });
    expect(again.spec.pattern).toMatchObject({ id: 'rag-assistant', overriddenBy: user.email, overrideReason: 'Answers come from the knowledge base' });
    expect(again.classification.pattern).toBe('conversational-copilot'); // the classifier's own answer is still recorded

    const changed = await service.submitUseCase(P, user, { ...copilot, business: { ...copilot.business, problem: 'Forecast weekly demand and predict churn from tabular sales history' }, data: [{ ...intake.data[0], source: 'Sales warehouse', format: 'sql tables' }] });
    expect(changed.spec.pattern).toMatchObject({ id: 'predictive-ml', overriddenBy: null });
  });
});
