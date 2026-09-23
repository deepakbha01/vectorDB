/** Security & Governance (AI Factory Wave 7) - mirrors backend/src/ai-factory/security/*. */

export type PolicyStatus = 'approved' | 'approved_with_conditions' | 'restricted' | 'not_eligible';

export interface CreateSecurityAssessmentInput {
  vendorDpaSigned?: boolean;
  vendorBaaSigned?: boolean;
}

export interface ComponentPolicy {
  id: string;
  kind: string;
  label: string;
  choice: string;
  source: string;
  external: boolean;
  dataPath: 'document' | 'request' | 'none';
  status: PolicyStatus;
  reasons: string[];
  conditions: string[];
}

export interface ControlAssessment {
  area: string;
  label: string;
  requirement: 'required' | 'recommended' | 'not_applicable';
  requiredBy: string | null;
  status: 'addressed' | 'gap' | 'recommended' | 'not_applicable';
  designedIn: Array<{ source: string; text: string }>;
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

export interface SecurityContext {
  classification: 'restricted' | 'confidential' | 'internal';
  containsPii: boolean;
  containsPhi: boolean;
  containsPci: boolean;
  dataResidency: string | null;
  vendorDpaSigned: boolean;
  vendorBaaSigned: boolean;
  missingDesigns: string[];
}

export type SecuritySources = Record<string, { source: string; detail: string }>;

export interface SecurityAssessment {
  id: string;
  version: number;
  submitted: CreateSecurityAssessmentInput;
  context: SecurityContext;
  sources: SecuritySources;
  result: SecurityResult;
  createdAt: string;
}

export interface SecurityDefaults {
  context: SecurityContext;
  sources: SecuritySources;
  preview: SecurityResult;
}
