import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { assessControls, assessSecurity, componentPolicy } from './security.engine';
import { resolveSecurityContext } from './security.service';
import { fromSecurityAssessment } from '../decision-record.adapters';
import { ComponentFacts, SecurityCatalogue, SecurityContext } from './security.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/security-governance.yaml'), 'utf8')) as SecurityCatalogue;

const embeddingApi: ComponentFacts = { id: 'embedding_model', kind: 'embedding_model', label: 'Embedding model', choice: 'text-embedding-3-small (openai)', source: 'Data Pipeline Design v1', external: true, dataPath: 'document', region: 'global (OpenAI API)' };
const apiModel: ComponentFacts = { id: 'model:api-mid', kind: 'model', label: 'Primary model', choice: 'API mid', source: 'Model Selection v1', external: true, dataPath: 'request', region: null, licence: { id: 'commercial_api', label: 'Provider terms of service', permissive: false } };
const selfHosted: ComponentFacts = { id: 'model:qwen', kind: 'model', label: 'Secondary model', choice: 'Qwen2.5 7B', source: 'Model Selection v1', external: false, dataPath: 'request', licence: { id: 'apache_2', label: 'Apache 2.0', permissive: true } };

const ctx = (o: Partial<SecurityContext> = {}): SecurityContext => ({
  classification: 'internal',
  containsPii: false,
  containsPhi: false,
  containsPci: false,
  dataResidency: null,
  regulatory: null,
  onPremOnly: false,
  requiresAuthentication: true,
  requiresRbac: false,
  requiresEncryptionAtRest: false,
  requiresEncryptionInTransit: true,
  requiresKeyManagement: false,
  requiresTenantIsolation: false,
  requiresAuditLogging: false,
  retentionDays: null,
  genAi: true,
  cloudPlacement: false,
  policyEngine: true,
  inBoundaryModel: true,
  vendorDpaSigned: false,
  vendorBaaSigned: false,
  components: [selfHosted],
  statements: [
    { source: 'Inference Architecture v1 · gateway', text: 'Authentication (OIDC / workload identity) and per-application authorisation' },
    { source: 'Inference Architecture v1 · policy engine', text: 'Prompt-injection screening on inputs and content filtering on outputs' },
    { source: 'Infrastructure Design v1 · security', text: 'Encryption in transit (TLS 1.2+)' },
    { source: 'RAG / Agent Architecture v1 · promptConstruction', text: 'Versioned prompt templates in a registry, rolled out like code.' },
    { source: 'Model Selection v1', text: 'Model licences recorded: Qwen2.5 7B - Apache 2.0' },
  ],
  missingDesigns: [],
  ...o,
});
const policy = (c: ComponentFacts, o: Partial<SecurityContext> = {}) => componentPolicy(c, ctx(o), cat, new Set());

describe('security catalogue (config/security-governance.yaml)', () => {
  it('covers the 18 control areas of spec §12 and the four policy statuses', () => {
    expect(cat.controls.map((c) => c.id)).toEqual([
      'identity', 'authentication', 'authorization', 'rbac', 'encryption', 'secrets', 'network_isolation', 'private_endpoints', 'data_residency',
      'pii', 'phi', 'prompt_security', 'prompt_injection', 'data_leakage', 'model_governance', 'audit', 'logging', 'retention',
    ]);
    expect(cat.statusOrder).toEqual(['approved', 'approved_with_conditions', 'restricted', 'not_eligible']);
    for (const c of cat.controls) expect(() => new RegExp(c.evidence, 'i')).not.toThrow();
  });
});

describe('component policy status', () => {
  it('approves a component that keeps data inside the boundary', () => {
    const p = policy(selfHosted);
    expect(p.status).toBe('approved');
    expect(p.reasons).toEqual(['Runs inside the customer boundary; no policy rule restricts it.']);
  });

  it('rules out external processing when only on-premises is allowed', () => {
    const p = policy(embeddingApi, { onPremOnly: true });
    expect(p.status).toBe('not_eligible');
    expect(p.reasons[0]).toMatch(/Every document passes through this component outside the customer boundary/);
  });

  it('separates the document path (cannot route around) from the request path (can) for restricted data', () => {
    expect(policy(embeddingApi, { classification: 'restricted', containsPci: true }).status).toBe('not_eligible');
    const m = policy(apiModel, { classification: 'restricted', containsPhi: true });
    expect(m.status).toBe('restricted');
    expect(m.conditions).toContain('The policy engine routes restricted requests to in-boundary components (Inference Architecture).');
    expect(policy(apiModel, { classification: 'restricted', containsPhi: true, inBoundaryModel: false }).status).toBe('not_eligible');
  });

  it('accepts PHI (not PCI) under a signed BAA, with conditions', () => {
    expect(policy(embeddingApi, { classification: 'restricted', containsPhi: true, vendorBaaSigned: true }).status).toBe('approved_with_conditions');
    expect(policy(embeddingApi, { classification: 'restricted', containsPhi: true, containsPci: true, vendorBaaSigned: true }).status).toBe('not_eligible');
  });

  it('needs a DPA for confidential data, and residency confirmation whatever the contract says', () => {
    const noDpa = policy({ ...embeddingApi, region: 'eu-west' }, { classification: 'confidential' });
    expect(noDpa.status).toBe('approved_with_conditions');
    expect(noDpa.conditions[0]).toMatch(/Sign a DPA/);
    expect(policy({ ...embeddingApi, region: 'eu-west' }, { classification: 'confidential', vendorDpaSigned: true }).status).toBe('approved');
    const global = policy(embeddingApi, { classification: 'confidential', vendorDpaSigned: true, dataResidency: 'EU' });
    expect(global.status).toBe('approved_with_conditions');
    expect(global.conditions).toContain('Confirm the vendor processes and stores data only inside "EU".');
  });

  it('flags non-permissive licences, an unverified compliance gate and conditional placements', () => {
    expect(policy(apiModel).conditions.join(' ')).toMatch(/Legal review of the licence terms/);
    const vdb = policy({ id: 'vector_database', kind: 'vector_database', label: 'Vector database', choice: 'qdrant', source: 'ADR', external: false, dataPath: 'document', complianceGate: { status: 'unverified', missing: ['Audit logging', 'Key management'] } });
    expect(vdb.status).toBe('approved_with_conditions');
    expect(vdb.conditions).toEqual(['Capture in Discovery: Audit logging, Key management.']);
    const dep = policy({ id: 'deployment:inference', kind: 'deployment', label: 'Deployment - inference', choice: 'On-premises', source: 'Infra', external: false, dataPath: 'none', placement: { eligibility: 'conditional', conditions: ['No GPUs on-premises today.'] } });
    expect(dep.conditions).toEqual(['No GPUs on-premises today.']);
  });

  it('restricts agent tools that act when no policy engine exists', () => {
    const tools: ComponentFacts = { id: 'agent_tools', kind: 'agent_tools', label: 'Agent tools', choice: 'external actions', source: 'RAG', external: false, dataPath: 'none', toolAccess: 'external_actions' };
    expect(policy(tools, { policyEngine: false }).status).toBe('restricted');
    expect(policy(tools).conditions).toEqual(['Human approval before every external action; every tool call audited.']);
    expect(policy({ ...tools, toolAccess: 'read_only' }).status).toBe('approved');
  });
});

describe('control areas', () => {
  it('traces required controls to the designs that address them, and reports the rest as gaps', () => {
    const byArea = Object.fromEntries(assessControls(ctx({ requiresAuditLogging: true, containsPii: true }), cat).map((c) => [c.area, c]));
    expect(byArea.authentication).toMatchObject({ requirement: 'required', status: 'addressed', requiredBy: 'Discovery: authentication required' });
    expect(byArea.authentication.designedIn[0].source).toBe('Inference Architecture v1 · gateway');
    expect(byArea.prompt_injection.status).toBe('addressed');
    expect(byArea.model_governance.status).toBe('addressed');
    expect(byArea.audit).toMatchObject({ requirement: 'required', status: 'gap' });
    expect(byArea.pii).toMatchObject({ requirement: 'required', status: 'gap' });
    expect(byArea.phi.status).toBe('not_applicable');
    expect(byArea.rbac.status).toBe('recommended');
  });

  it('does not count incidental wording as a control', () => {
    const incidental = ctx({
      classification: 'confidential',
      statements: [
        { source: 'RAG', text: 'Llama 3.3 70B Instruct: tool calling supported, structured output supported.' },
        { source: 'RAG', text: 'Hybrid query in qdrant; tune the dense / keyword weighting on the evaluation set.' },
        { source: 'RAG', text: 'Code or shell tools run in a sandbox with an egress allow-list when needed.' },
      ],
    });
    const byArea = Object.fromEntries(assessControls(incidental, cat).map((c) => [c.area, c.status]));
    expect(byArea).toMatchObject({ data_leakage: 'gap', model_governance: 'gap', authorization: 'recommended' });
  });

  it('treats PHI as personal data for the PII controls', () => {
    const pii = assessControls(ctx({ containsPhi: true }), cat).find((c) => c.area === 'pii')!;
    expect(pii).toMatchObject({ requirement: 'required', requiredBy: 'PHI is personal data' });
  });
});

describe('assessSecurity', () => {
  it('fails validation when any component is not eligible, and names it', () => {
    const r = assessSecurity(ctx({ onPremOnly: true, components: [selfHosted, embeddingApi] }), cat);
    expect(r.overall.status).toBe('not_eligible');
    expect(r.validation.status).toBe('fail');
    expect(r.validation.reasons[0]).toMatch(/^Embedding model \(text-embedding-3-small \(openai\)\) is not eligible/);
    expect(r.wouldChangeIf).toContain('Self-hosting the embedding model would keep documents on-premises.');
  });

  it('asks for further assessment when a required control is not designed or a design is missing', () => {
    const r = assessSecurity(ctx({ requiresAuditLogging: true }), cat);
    expect(r.validation.status).toBe('further_assessment');
    expect(r.gaps).toEqual([
      'Audit: required (Discovery: audit logging) but no upstream design addresses it.',
      'Logging: required (Discovery: audit logging) but no upstream design addresses it.',
    ]);
    expect(assessSecurity(ctx({ missingDesigns: ['RAG / Agent Architecture'] }), cat).gaps).toEqual(['No RAG / Agent Architecture yet - its security controls could not be checked.']);
  });

  it('passes with conditions, or passes outright', () => {
    const c = assessSecurity(ctx({ components: [selfHosted, apiModel] }), cat);
    expect(c.validation.status).toBe('pass_with_conditions');
    expect(c.overall.summary).toBe('2 component(s): 1 approved, 1 approved with conditions; 0 required control gap(s).');
    expect(assessSecurity(ctx(), cat).validation).toEqual({ status: 'pass', reasons: ['Every component is approved and every required control is addressed in the design.'] });
  });

  it('adds PHI and PCI verification steps only when they are in scope', () => {
    expect(assessSecurity(ctx(), cat).verificationRequired.join(' ')).not.toMatch(/HIPAA|PCI|DPIA/);
    expect(assessSecurity(ctx({ containsPhi: true, containsPci: true }), cat).verificationRequired.join(' ')).toMatch(/HIPAA.*PCI/);
  });

  it('becomes a standard decision record with no alternatives (an assessment, not a choice)', () => {
    const r = assessSecurity(ctx({ components: [selfHosted, apiModel] }), cat);
    const rec = fromSecurityAssessment({ id: 's', version: 1, createdAt: new Date(), sources: {}, context: { missingDesigns: [] }, result: r } as any);
    expect(rec).toMatchObject({ phase: 'security_governance', status: 'conditional', confidence: 'high', alternatives: [] });
    expect(rec.recommendation!.label).toBe('Approved with conditions - security validation: pass with conditions');
    expect(rec.candidates.map((k) => k.eligibility)).toEqual(['eligible', 'conditional']);
  });
});

describe('resolveSecurityContext', () => {
  const catalogues = {
    models: { licences: { apache_2: { label: 'Apache 2.0', permissive: true, note: '' }, commercial_api: { label: 'Provider terms of service', permissive: false, note: '' } }, models: [{ id: 'open', licence: 'apache_2' }, { id: 'api', licence: 'commercial_api' }] } as any,
    managedServingIds: ['managed-api'],
    externalRerankIds: ['managed_rerank_api'],
    embeddingRegion: (p: string, m: string) => (p === 'openai' && m === 'te3' ? 'global (OpenAI API)' : null),
  };
  const inputs = (o: Record<string, any> = {}): any => ({
    project: { platform: 'undetermined' },
    profile: { version: 2, inputs: { deploymentTargets: { value: ['azure'] }, containsPhi: { value: true }, containsPci: { value: false }, dataResidencyRequirement: { value: 'EU' } }, result: { dataClassification: { level: 'restricted', reasons: ['PHI'] } } },
    discovery: { version: 3, containsPii: true, requiresAuthentication: true, requiresRbac: true, requiresAuditLogging: true, retentionDays: 90, requiresTenantIsolation: false },
    pipeline: { version: 1, embeddingProviderId: 'openai', embeddingModelId: 'te3' },
    adr: { decision: 'pinecone', complianceGate: { status: 'unverified', checks: [{ control: 'Audit logging', satisfied: true }, { control: 'Key management', satisfied: false }] } },
    selection: { version: 4, result: { primary: { id: 'open', label: 'Open 70B', family: 'open_weight' }, secondary: { id: 'api', label: 'API mid', family: 'proprietary_api' }, fallback: { id: 'open', label: 'Open 70B', family: 'open_weight' } } },
    architecture: { version: 5, result: { recommended: { id: 'vllm', label: 'vLLM' }, architecture: { gateway: ['Authentication (OIDC)'], policy: ['PII detection and redaction'], security: [], observability: [] } } },
    infrastructure: { version: 6, result: { placements: [{ component: 'inference', componentLabel: 'Inference serving', chosen: { label: 'Azure - AKS', target: 'azure', eligibility: 'conditional', conditions: ['Private Link'] } }], sections: { security: ['Azure: Key Vault'], network: [] } } },
    ragAgent: null,
    ...o,
  });

  it('builds components from the design records and marks what leaves the boundary', () => {
    const { context } = resolveSecurityContext({}, inputs(), catalogues);
    expect(context.components.map((c) => [c.id, c.external, c.dataPath])).toEqual([
      ['vector_database', true, 'document'],
      ['embedding_model', true, 'document'],
      ['model:open', false, 'request'],
      ['model:api', true, 'request'],
      ['serving_runtime', false, 'none'],
      ['deployment:inference', false, 'none'],
    ]);
    expect(context.components[0].complianceGate).toEqual({ status: 'unverified', missing: ['Key management'] });
    expect(context.components[1].region).toBe('global (OpenAI API)');
    expect(context).toMatchObject({ classification: 'restricted', containsPhi: true, containsPii: true, inBoundaryModel: true, cloudPlacement: true, policyEngine: true, retentionDays: 90, dataResidency: 'EU' });
    expect(context.missingDesigns).toEqual(['RAG / Agent Architecture']);
    expect(context.statements.map((s) => s.source)).toEqual(['Inference Architecture v5 · gateway', 'Inference Architecture v5 · policy engine', 'Infrastructure Design v6 · security', 'Model Selection v4']);
  });

  it('treats open-weight models on managed serving as external', () => {
    const { context } = resolveSecurityContext({}, inputs({ architecture: { version: 5, result: { recommended: { id: 'managed-api', label: 'Managed' }, architecture: null } } }), catalogues);
    expect(context.components.find((c) => c.id === 'model:open')!.external).toBe(true);
    expect(context.inBoundaryModel).toBe(false);
    expect(context.policyEngine).toBe(false);
  });

  it('records the contract answers and refuses to assess with no inputs', () => {
    const { context, sources } = resolveSecurityContext({ vendorBaaSigned: true }, inputs(), catalogues);
    expect(context.vendorBaaSigned).toBe(true);
    expect(sources.vendorBaaSigned.source).toBe('user');
    expect(sources.vendorDpaSigned.source).toBe('default');
    expect(() => resolveSecurityContext({}, inputs({ profile: null, discovery: null }), catalogues)).toThrow(BadRequestException);
  });
});
