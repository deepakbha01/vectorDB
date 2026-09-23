export type PolicyStatus = 'approved' | 'approved_with_conditions' | 'restricted' | 'not_eligible';
export type DataPath = 'document' | 'request' | 'none';
export type ComponentKind = 'vector_database' | 'embedding_model' | 'model' | 'serving_runtime' | 'reranker' | 'agent_tools' | 'deployment';
export type ControlArea =
  | 'identity'
  | 'authentication'
  | 'authorization'
  | 'rbac'
  | 'encryption'
  | 'secrets'
  | 'network_isolation'
  | 'private_endpoints'
  | 'data_residency'
  | 'pii'
  | 'phi'
  | 'prompt_security'
  | 'prompt_injection'
  | 'data_leakage'
  | 'model_governance'
  | 'audit'
  | 'logging'
  | 'retention';

export interface SecurityCatalogue {
  rulesVersion: string;
  statusOrder: PolicyStatus[];
  statusLabels: Record<PolicyStatus, string>;
  externalProcessing: {
    onPremOnly: PolicyStatus;
    restricted: { documentPath: PolicyStatus; requestPath: PolicyStatus; phiOnlyWithBaa: PolicyStatus };
    confidential: { withoutDpa: PolicyStatus; withDpa: PolicyStatus };
    internal: PolicyStatus;
  };
  complianceGate: Record<'passed' | 'unverified' | 'not_applicable', PolicyStatus>;
  nonPermissiveLicence: PolicyStatus;
  placementConditional: PolicyStatus;
  agentTools: Record<'none' | 'read_only' | 'read_write' | 'external_actions' | 'withoutPolicyEngine', PolicyStatus>;
  controls: Array<{ id: ControlArea; label: string; evidence: string; actions: string[] }>;
  verificationRequired: string[];
}

/** A component of the chosen architecture, as the upstream records describe it. */
export interface ComponentFacts {
  id: string;
  kind: ComponentKind;
  label: string;
  choice: string;
  source: string;
  external: boolean;
  dataPath: DataPath;
  region?: string | null;
  licence?: { id: string; label: string; permissive: boolean } | null;
  complianceGate?: { status: 'not_applicable' | 'passed' | 'unverified'; missing: string[] } | null;
  placement?: { eligibility: string; conditions: string[] } | null;
  toolAccess?: 'none' | 'read_only' | 'read_write' | 'external_actions';
}

/** A security statement produced by an upstream design, with where it came from. */
export interface DesignStatement {
  source: string;
  text: string;
}

export interface SecurityContext {
  classification: 'restricted' | 'confidential' | 'internal';
  containsPii: boolean;
  containsPhi: boolean;
  containsPci: boolean;
  dataResidency: string | null;
  regulatory: string | null;
  onPremOnly: boolean;
  requiresAuthentication: boolean;
  requiresRbac: boolean;
  requiresEncryptionAtRest: boolean;
  requiresEncryptionInTransit: boolean;
  requiresKeyManagement: boolean;
  requiresTenantIsolation: boolean;
  requiresAuditLogging: boolean;
  retentionDays: number | null;
  genAi: boolean;
  cloudPlacement: boolean;
  policyEngine: boolean;
  inBoundaryModel: boolean;
  vendorDpaSigned: boolean;
  vendorBaaSigned: boolean;
  components: ComponentFacts[];
  statements: DesignStatement[];
  /** Upstream designs that do not exist yet (their controls cannot be found). */
  missingDesigns: string[];
}

export interface ComponentPolicy {
  id: string;
  kind: ComponentKind;
  label: string;
  choice: string;
  source: string;
  external: boolean;
  dataPath: DataPath;
  status: PolicyStatus;
  reasons: string[];
  conditions: string[];
}

export interface ControlAssessment {
  area: ControlArea;
  label: string;
  requirement: 'required' | 'recommended' | 'not_applicable';
  requiredBy: string | null;
  status: 'addressed' | 'gap' | 'recommended' | 'not_applicable';
  designedIn: DesignStatement[];
  actions: string[];
}

export interface SecurityResult {
  rulesVersion: string;
  overall: { status: PolicyStatus; label: string; summary: string };
  validation: { status: 'pass' | 'pass_with_conditions' | 'further_assessment' | 'fail'; reasons: string[] };
  components: ComponentPolicy[];
  controls: ControlAssessment[];
  gaps: string[];
  wouldChangeIf: string[];
  verificationRequired: string[];
}
