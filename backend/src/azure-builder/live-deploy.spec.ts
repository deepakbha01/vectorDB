import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ArmClient } from './arm-client';
import { AzureCatalog, DEFAULT_OPTIONS, designArchitecture } from './architecture';
import { SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile } from './environment-profile';
import { generateIacBundle, IacCatalog, TARGET_ENVS, TargetEnv } from './iac-bundle';
import { compileForArm, IacCompileError } from './iac-validate';
import { leafErrors, runLiveWhatIf, stackName, summariseStack, whatIfDeploymentName } from './live-deploy';

describe('names', () => {
  it('builds ARM-safe what-if deployment and stack names', () => {
    expect(whatIfDeploymentName('hrpoliassi', 'dev', 3)).toBe('azb-hrpoliassi-dev-v3-whatif');
    expect(stackName('hrpoliassi', 'prod')).toBe('azb-hrpoliassi-prod');
    expect(stackName('a b/c'.repeat(20), 'dev')).toMatch(/^[\w.()-]{1,64}$/);
  });
});

describe('summariseStack', () => {
  it('reports a deploying stack as running, with no errors yet', () => {
    expect(summariseStack({ properties: { provisioningState: 'deploying' } })).toEqual({ state: 'running', provisioningState: 'deploying', outputs: {}, resourceIds: [], errors: [], armDeploymentId: null });
  });

  it('flattens outputs and keeps resource IDs on success', () => {
    const s = summariseStack({ properties: { provisioningState: 'succeeded', deploymentId: '/d/1', outputs: { apiUrl: { type: 'String', value: 'https://x' }, n: { value: 2 } }, resources: [{ id: '/r/1' }, {}] } });
    expect(s).toMatchObject({ state: 'succeeded', outputs: { apiUrl: 'https://x', n: 2 }, resourceIds: ['/r/1'], armDeploymentId: '/d/1' });
  });

  it('finds the real cause and the failing resource in ARM\'s nested errors, without duplicates', () => {
    const cause = { code: 'InsufficientQuota', message: 'Not enough TPM quota.' };
    const s = summariseStack({
      properties: {
        provisioningState: 'Failed',
        failedResources: [{ id: '/r/oai', error: { code: 'ResourceDeploymentFailure', message: 'x', details: [cause] } }],
        error: { code: 'DeploymentFailed', message: 'At least one failed.', details: [{ code: 'ResourceDeploymentFailure', target: '/r/oai', details: [cause] }] },
      },
    });
    expect(s.state).toBe('failed');
    expect(s.errors).toEqual([{ code: 'InsufficientQuota', message: 'Not enough TPM quota.', resource: '/r/oai' }]);
  });

  it('keeps a top-level error that has no details', () => {
    expect(leafErrors({ code: 'InvalidTemplate', message: 'Bad template.' })).toEqual([{ code: 'InvalidTemplate', message: 'Bad template.', resource: null }]);
  });
});

describe('runLiveWhatIf', () => {
  it('posts an incremental what-if at resource-group scope and polls the 202 until the result is ready', async () => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => (body === '' ? '' : JSON.stringify(body)) });
    const fetch = jest.fn()
      .mockResolvedValueOnce(reply(202, '', { location: 'https://management.azure.com/subscriptions/s/operationresults/1', 'retry-after': '3' }))
      .mockResolvedValueOnce(reply(202, '', { location: 'https://management.azure.com/subscriptions/s/operationresults/1' }))
      .mockResolvedValueOnce(reply(200, { status: 'Succeeded', properties: { changes: [] } }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const out = await runLiveWhatIf(new ArmClient('t', { fetch, sleep }), { subscriptionId: 's', resourceGroup: 'rg 1' }, 'azb-x-dev-v1-whatif', { resources: [] }, { p: { value: 1 } });
    expect(out).toEqual({ status: 'Succeeded', properties: { changes: [] } });
    expect(fetch.mock.calls[0][0]).toBe('https://management.azure.com/subscriptions/s/resourceGroups/rg%201/providers/Microsoft.Resources/deployments/azb-x-dev-v1-whatif/whatIf?api-version=2024-03-01');
    expect(JSON.parse(fetch.mock.calls[0][1].body).properties).toMatchObject({ mode: 'Incremental', parameters: { p: { value: 1 } } });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000, 5000]);
  });

  it('refuses to follow a poll address outside management.azure.com', async () => {
    const fetch = jest.fn().mockResolvedValue({ status: 202, headers: { get: (n: string) => (n === 'location' ? 'https://evil.example.com/poll' : null) }, text: async () => '' });
    await expect(runLiveWhatIf(new ArmClient('t', { fetch, sleep: async () => undefined }), { subscriptionId: 's', resourceGroup: 'rg' }, 'n', {}, {})).rejects.toThrow('outside management.azure.com');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('compileForArm', () => {
  it('needs a Bicep CLI', async () => {
    await expect(compileForArm([], 'dev', undefined)).rejects.toBeInstanceOf(IacCompileError);
  });

  // Integration: runs the real Bicep CLI (and restores AVM modules from the public registry) when AZURE_BUILDER_BICEP_PATH is set.
  const bicep = process.env.AZURE_BUILDER_BICEP_PATH;
  (bicep ? it : it.skip)('compiles a generated bundle environment into an ARM template and parameters', async () => {
    const catalog = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/azure-builder.yaml'), 'utf8')) as AzureCatalog & { iac: IacCatalog };
    const sample = buildEnvironmentProfile(SAMPLE_SUBSCRIPTION_ID, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_FORM_INPUT, '2026-10-07T00:00:00.000Z');
    const profile = { ...sample, network: { vnets: [], hubVnetId: null, privateDnsZones: [] }, monitoring: { workspaces: [], logAnalyticsId: null }, policy: { allowedLocations: [], requiredTags: [], denyPublicNetworkAccess: false, deniedSkus: [] } };
    const useCase = {
      name: 'HR policy assistant', business: { problem: 'p', kpis: ['k'], sponsor: 's', costCenter: 'HR-001' },
      users: { type: 'internal' as const, count: 500, peakConcurrent: 20, channels: ['web' as const] },
      data: [{ source: 'SP', format: 'pdf', volumeGb: 5, classification: 'internal' as const, containsPersonalData: false, refresh: 'daily' as const }],
      constraints: { regions: ['centralindia'], dataResidency: null, compliance: [], latencyMs: 3000, availability: '99.9', monthlyBudgetUsd: 5000 },
      environment: 'dev' as const, owner: 'a@b.c',
      pattern: { id: 'rag-assistant' as const, confidence: 0.8, rationale: 'r', overriddenBy: null, overrideReason: null, classifiedAs: 'rag-assistant' as const, missingInfo: [], riskClass: 'medium' as const, supportedInMvp: true },
    };
    const design = (env: TargetEnv) => designArchitecture({ useCase: { ...useCase, environment: env }, useCaseId: '7f3c2a10-1111-4222-8333-944445555666', useCaseVersion: 1, profile, profileVersion: 1, connection: { region: 'centralindia', deploymentModel: 'centralised' }, options: DEFAULT_OPTIONS, catalog });
    const bundle = generateIacBundle({ spec: design('dev'), specsByEnv: Object.fromEntries(TARGET_ENVS.map((e) => [e, design(e)])) as any, architectureVersion: 1, workload: 'hrprobe', catalog });
    const out = await compileForArm(bundle.files, 'dev', bicep);
    expect(out.tool).toMatch(/Bicep CLI version/);
    expect(out.template).toMatchObject({ $schema: expect.stringContaining('deploymentTemplate.json') });
    expect(out.parameters).toMatchObject({ workload: { value: 'hrprobe' }, environment: { value: 'dev' } });
  }, 300_000);
});
