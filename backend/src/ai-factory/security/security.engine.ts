import { ComponentFacts, ComponentPolicy, ControlArea, ControlAssessment, PolicyStatus, SecurityCatalogue, SecurityContext, SecurityResult } from './security.types';

export function worst(a: PolicyStatus, b: PolicyStatus, cat: SecurityCatalogue): PolicyStatus {
  return cat.statusOrder.indexOf(a) >= cat.statusOrder.indexOf(b) ? a : b;
}

const restrictedInScope = (ctx: SecurityContext) => ctx.classification === 'restricted' || ctx.containsPhi || ctx.containsPci;

/** Spec §12 component policy status: what the component does with data, never who makes it. Pure. */
export function componentPolicy(c: ComponentFacts, ctx: SecurityContext, cat: SecurityCatalogue, hints: Set<string>): ComponentPolicy {
  let status = 'approved' as PolicyStatus;
  const reasons: string[] = [];
  const conditions: string[] = [];
  const apply = (s: PolicyStatus, reason: string, condition?: string) => {
    status = worst(status, s, cat);
    reasons.push(reason);
    if (condition) conditions.push(condition);
  };
  const ep = cat.externalProcessing;

  if (c.external) {
    const where = c.dataPath === 'document' ? 'Every document passes through this component' : 'Requests are processed by this component';
    if (ctx.onPremOnly) {
      apply(ep.onPremOnly, `${where} outside the customer boundary, and only on-premises deployment is allowed.`);
      hints.add(c.dataPath === 'document' ? `Self-hosting the ${c.label.toLowerCase()} would keep documents on-premises.` : `An on-premises alternative to the ${c.label.toLowerCase()} would make it eligible.`);
    } else if (restrictedInScope(ctx)) {
      const phiOnly = ctx.containsPhi && !ctx.containsPci;
      if (phiOnly && ctx.vendorBaaSigned) {
        apply(ep.restricted.phiOnlyWithBaa, 'PHI leaves the boundary under a signed BAA.', "Confirm the vendor's HIPAA-eligible service, the processing region and zero data retention.");
      } else if (c.dataPath === 'document') {
        apply(ep.restricted.documentPath, `${where} - restricted data (${[ctx.containsPhi && 'PHI', ctx.containsPci && 'PCI'].filter(Boolean).join(' / ') || 'restricted'}) cannot be routed around it.`);
        hints.add(`Self-hosting the ${c.label.toLowerCase()} keeps restricted documents in the boundary.`);
        if (phiOnly) hints.add('A signed BAA would make PHI processing by external vendors approvable with conditions.');
      } else if (c.kind === 'model' && !ctx.inBoundaryModel) {
        apply('not_eligible', 'Restricted requests have no in-boundary model to route to - this external model would receive them.');
        hints.add('Adding an in-boundary (self-hosted) model to Model Selection lets restricted requests stay inside.');
      } else {
        apply(ep.restricted.requestPath, 'Usable only for requests without restricted data.', ctx.policyEngine ? 'The policy engine routes restricted requests to in-boundary components (Inference Architecture).' : 'No policy engine yet to keep restricted requests away - design the Inference Architecture.');
      }
    } else if (ctx.classification === 'confidential' || ctx.containsPii) {
      if (ctx.vendorDpaSigned) apply(ep.confidential.withDpa, 'Confidential data / PII processed externally under a signed DPA.');
      else {
        apply(ep.confidential.withoutDpa, 'Confidential data / PII is processed externally.', 'Sign a DPA: no training on customer data, limited retention, sub-processor list.');
        hints.add('A signed DPA with the external vendors approves their components outright.');
      }
    } else {
      apply(ep.internal, 'Processes internal data only.');
    }
    if (ctx.dataResidency && status !== 'not_eligible') {
      const region = c.region ?? null;
      if (!region || /global/i.test(region)) apply('approved_with_conditions', `Processing region is ${region ? `"${region}"` : 'not stated'}.`, `Confirm the vendor processes and stores data only inside "${ctx.dataResidency}".`);
    }
  }

  if (c.licence && !c.licence.permissive) {
    apply(cat.nonPermissiveLicence, `Licence: ${c.licence.label} (not permissive).`, 'Legal review of the licence terms (use restrictions, attribution, user thresholds) before production.');
  }
  if (c.complianceGate && c.complianceGate.status !== 'not_applicable') {
    const s = cat.complianceGate[c.complianceGate.status];
    if (c.complianceGate.status === 'passed') apply(s, 'Vector DB compliance gate passed (all PII controls captured).');
    else apply(s, 'Vector DB compliance gate unverified.', `Capture in Discovery: ${c.complianceGate.missing.join(', ')}.`);
  }
  if (c.placement && c.placement.eligibility === 'conditional') {
    apply(cat.placementConditional, 'Placement is conditional (Infrastructure Design).');
    conditions.push(...c.placement.conditions);
  }
  if (c.toolAccess) {
    const acts = c.toolAccess === 'read_write' || c.toolAccess === 'external_actions';
    if (acts && !ctx.policyEngine) apply(cat.agentTools.withoutPolicyEngine, 'Agent tools can change things, and there is no policy engine to enforce guardrails.');
    else apply(cat.agentTools[c.toolAccess], `Agent tool access: ${c.toolAccess.replace(/_/g, ' ')}.`, acts ? (c.toolAccess === 'external_actions' ? 'Human approval before every external action; every tool call audited.' : 'Approval before irreversible writes; idempotency keys on write tools.') : undefined);
  }
  if (!reasons.length) reasons.push('Runs inside the customer boundary; no policy rule restricts it.');
  return { id: c.id, kind: c.kind, label: c.label, choice: c.choice, source: c.source, external: c.external, dataPath: c.dataPath, status, reasons, conditions };
}

/** Why a control is required, recommended or not applicable here. */
export function controlRequirement(area: ControlArea, ctx: SecurityContext): { requirement: ControlAssessment['requirement']; requiredBy: string | null } {
  const req = (by: string) => ({ requirement: 'required' as const, requiredBy: by });
  const rec = { requirement: 'recommended' as const, requiredBy: null };
  const na = { requirement: 'not_applicable' as const, requiredBy: null };
  const sensitive = ctx.classification !== 'internal';
  switch (area) {
    case 'identity':
    case 'authentication':
      return ctx.requiresAuthentication ? req('Discovery: authentication required') : rec;
    case 'authorization':
      return ctx.requiresRbac || ctx.requiresTenantIsolation ? req(ctx.requiresTenantIsolation ? 'Discovery: tenant isolation' : 'Discovery: RBAC') : rec;
    case 'rbac':
      return ctx.requiresRbac ? req('Discovery: RBAC') : rec;
    case 'encryption':
      return ctx.requiresEncryptionAtRest || ctx.requiresEncryptionInTransit
        ? req(`Discovery: encryption ${[ctx.requiresEncryptionAtRest && 'at rest', ctx.requiresEncryptionInTransit && 'in transit'].filter(Boolean).join(' and ')}`)
        : rec;
    case 'secrets':
      return ctx.requiresKeyManagement ? req('Discovery: key management') : rec;
    case 'network_isolation':
      return sensitive ? req(`${ctx.classification} data`) : rec;
    case 'private_endpoints':
      return !ctx.cloudPlacement && !ctx.components.some((c) => c.external) ? na : sensitive ? req(`${ctx.classification} data in cloud or external services`) : rec;
    case 'data_residency':
      return ctx.dataResidency ? req(`Residency: ${ctx.dataResidency}`) : na;
    case 'pii':
      return ctx.containsPii ? req('PII in scope') : ctx.containsPhi ? req('PHI is personal data') : na;
    case 'phi':
      return ctx.containsPhi ? req('PHI in scope') : na;
    case 'prompt_security':
    case 'prompt_injection':
    case 'model_governance':
      return ctx.genAi ? req('GenAI workload') : na;
    case 'data_leakage':
      return sensitive || ctx.requiresTenantIsolation ? req(ctx.requiresTenantIsolation ? 'Discovery: tenant isolation' : `${ctx.classification} data`) : ctx.genAi ? rec : na;
    case 'audit':
      return ctx.requiresAuditLogging ? req('Discovery: audit logging') : ctx.regulatory ? req(`Regulation: ${ctx.regulatory}`) : rec;
    case 'logging':
      return ctx.requiresAuditLogging ? req('Discovery: audit logging') : rec;
    case 'retention':
      return ctx.retentionDays ? req(`Discovery: ${ctx.retentionDays}-day retention`) : ctx.containsPii ? req('PII in scope') : rec;
  }
}

export function assessControls(ctx: SecurityContext, cat: SecurityCatalogue): ControlAssessment[] {
  return cat.controls.map((c) => {
    const { requirement, requiredBy } = controlRequirement(c.id, ctx);
    const re = new RegExp(c.evidence, 'i');
    const designedIn = requirement === 'not_applicable' ? [] : ctx.statements.filter((s) => re.test(s.text));
    const status: ControlAssessment['status'] = requirement === 'not_applicable' ? 'not_applicable' : designedIn.length ? 'addressed' : requirement === 'required' ? 'gap' : 'recommended';
    return { area: c.id, label: c.label, requirement, requiredBy, status, designedIn, actions: requirement === 'not_applicable' ? [] : c.actions };
  });
}

/** AI Security & Governance Assessment (spec §12). Pure. */
export function assessSecurity(ctx: SecurityContext, cat: SecurityCatalogue): SecurityResult {
  const hints = new Set<string>();
  const components = ctx.components.map((c) => componentPolicy(c, ctx, cat, hints));
  const controls = assessControls(ctx, cat);
  const overallStatus = components.reduce<PolicyStatus>((s, c) => worst(s, c.status, cat), 'approved');

  const gaps = [
    ...controls.filter((c) => c.status === 'gap').map((c) => `${c.label}: required (${c.requiredBy}) but no upstream design addresses it.`),
    ...ctx.missingDesigns.map((d) => `No ${d} yet - its security controls could not be checked.`),
  ];
  const count = (s: PolicyStatus) => components.filter((c) => c.status === s).length;
  const notEligible = components.filter((c) => c.status === 'not_eligible');
  const reasons: string[] = [];
  let status: SecurityResult['validation']['status'];
  if (!components.length) {
    status = 'further_assessment';
    reasons.push('No architecture components to assess yet.');
  } else if (notEligible.length) {
    status = 'fail';
    reasons.push(...notEligible.map((c) => `${c.label} (${c.choice}) is not eligible: ${c.reasons[0]}`));
  } else if (gaps.length) {
    status = 'further_assessment';
    reasons.push(`${gaps.length} required control(s) not yet designed or checked.`);
  } else if (overallStatus !== 'approved') {
    status = 'pass_with_conditions';
    reasons.push(`${count('approved_with_conditions') + count('restricted')} component(s) approved only with conditions or restrictions.`);
  } else {
    status = 'pass';
    reasons.push('Every component is approved and every required control is addressed in the design.');
  }
  if (status !== 'fail' && count('restricted')) reasons.push(`${count('restricted')} component(s) restricted to non-restricted data.`);

  const summary = `${components.length} component(s): ${cat.statusOrder
    .map((s) => [count(s), cat.statusLabels[s].toLowerCase()] as const)
    .filter(([n]) => n)
    .map(([n, l]) => `${n} ${l}`)
    .join(', ')}; ${controls.filter((c) => c.status === 'gap').length} required control gap(s).`;

  return {
    rulesVersion: cat.rulesVersion,
    overall: { status: overallStatus, label: cat.statusLabels[overallStatus], summary },
    validation: { status, reasons },
    components,
    controls,
    gaps,
    wouldChangeIf: [...hints],
    verificationRequired: [...cat.verificationRequired.filter((v) => !v.startsWith('Data protection') || ctx.containsPii || ctx.containsPhi), ...(ctx.containsPhi ? ['HIPAA risk assessment and BAA inventory for every processor'] : []), ...(ctx.containsPci ? ['PCI DSS scoping - keep card data out of prompts, logs and vectors'] : [])],
  };
}
