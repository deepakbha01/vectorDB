import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService, permissionFor } from './azure-builder.service';
import { AzureRole, ConnectionSource, DeploymentModel, ProfileSource, ResourceGroupMode } from './azure-builder.enums';

/** A tiny in-memory stand-in for a TypeORM repository: create / save / count / find / findOne by project, ordered by version. */
function memoryRepo() {
  const rows: any[] = [];
  const byProject = (where: any) => rows.filter((r) => r.project.id === where.project.id);
  return {
    rows,
    create: (x: any) => ({ ...x }),
    save: async (x: any) => { const saved = { id: `id-${rows.length + 1}`, createdAt: new Date(), ...x }; rows.push(saved); return saved; },
    count: async ({ where }: any) => byProject(where).length,
    find: async ({ where }: any) => byProject(where).sort((a, b) => b.version - a.version),
    findOne: async ({ where }: any) => byProject(where).sort((a, b) => b.version - a.version)[0] ?? null,
  };
}

const user = { id: 'u1', email: 'architect@example.com', role: 'architect' } as any;
const P = 'project-1';
const connectDto = {
  tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', subscriptionId: '11111111-2222-4333-8444-555555555555', resourceGroup: 'rg-uc-hr-dev',
  resourceGroupMode: ResourceGroupMode.NEW, region: 'CentralIndia', deploymentModel: DeploymentModel.HUB_AND_SPOKE, role: AzureRole.CONTRIBUTOR,
};

function setup() {
  const connections = memoryRepo();
  const profiles = memoryRepo();
  const projects = { findOne: jest.fn().mockResolvedValue({ id: P }) };
  const service = new AzureBuilderService(connections as any, profiles as any, projects as any);
  return { service, connections, profiles, projects };
}

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

describe('AzureBuilderEnabledGuard', () => {
  it('hides the endpoints unless AZURE_BUILDER_ENABLED is on', () => {
    const guard = (v?: string) => new AzureBuilderEnabledGuard({ get: (k: string) => (k === 'AZURE_BUILDER_ENABLED' ? v : undefined) } as unknown as ConfigService);
    expect(() => guard(undefined).canActivate()).toThrow(NotFoundException);
    expect(() => guard('false').canActivate()).toThrow(NotFoundException);
    expect(guard('true').canActivate()).toBe(true);
  });
});
