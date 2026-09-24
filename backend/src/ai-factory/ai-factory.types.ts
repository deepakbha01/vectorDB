/**
 * AI Factory - Wave 1 foundation types.
 *
 * Everything here is a READ MODEL over the existing phase deliverables: the
 * AI Factory layer never changes how a phase computes or stores its output.
 */

export type PhaseKey =
  | 'discovery'
  | 'data_embeddings'
  | 'index_design'
  | 'vector_db_selection'
  | 'infrastructure'
  | 'optimization'
  | 'capacity'
  | 'inference'
  | 'workload_profile'
  | 'model_selection'
  | 'inference_architecture';

export type DependencyKind = 'hard' | 'advisory';

export interface PhaseDefinition {
  key: PhaseKey;
  label: string;
  route: string;
  dependsOn: Array<{ phase: PhaseKey; kind: DependencyKind }>;
}

export interface StepDefinition {
  number: number;
  key: string;
  title: string;
  phases: PhaseKey[];
  coverage: 'full' | 'partial' | 'none';
  plannedWave?: number;
  note?: string;
}

// ------------------------------------------------------------------ lineage

/** One saved version of a phase deliverable (only what lineage needs). */
export interface DeliverableVersion {
  id: string;
  version: number;
  createdAt: Date;
}

/**
 * current      - built from the latest version of every upstream it depends on
 * stale        - a hard upstream changed (or is itself stale) since this was built: re-run it
 * review       - only an advisory upstream changed: suggestions may be out of date
 * not_started  - no deliverable yet
 */
export type LineageStatus = 'current' | 'stale' | 'review' | 'not_started';

export interface UpstreamLink {
  phase: PhaseKey;
  kind: DependencyKind;
  /** Upstream version that was the latest when this deliverable was created (null if it did not exist yet). */
  builtFromVersion: number | null;
  latestVersion: number | null;
  changedSinceBuilt: boolean;
}

export interface StaleReason {
  type: 'upstream_changed' | 'upstream_stale' | 'built_before_upstream' | 'advisory_changed';
  phase: PhaseKey;
  message: string;
}

export interface PhaseLineage {
  phase: PhaseKey;
  label: string;
  route: string;
  status: LineageStatus;
  latest: DeliverableVersion | null;
  versions: number;
  upstream: UpstreamLink[];
  reasons: StaleReason[];
  /** Discovery fields that changed since this phase was built and that it depends on (directly or through upstream phases). */
  changedDiscoveryFields?: string[];
}

// ------------------------------------------------------------------- impact

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  /** Phases that read this field directly; empty when the field drives no decision today. */
  directPhases: PhaseKey[];
}

export interface AffectedPhase {
  phase: PhaseKey;
  label: string;
  action: 'rerun' | 'review';
  because: string[];
}

export interface ImpactAnalysis {
  fromVersion: number;
  toVersion: number;
  changes: FieldChange[];
  affected: AffectedPhase[];
  unaffected: Array<{ phase: PhaseKey; label: string; reason: string }>;
  /** Changed fields that no engine reads today (captured for context only). */
  noImpactFields: string[];
}

// --------------------------------------------------------- decision record

/** Spec §13/§24: every figure must say what kind of evidence it is. */
export type EvidenceType = 'estimated' | 'vendor_listed' | 'measured' | 'assumption';

export type Eligibility = 'eligible' | 'conditional' | 'not_eligible' | 'not_assessed';

export interface DecisionCandidate {
  id: string;
  label: string;
  eligibility: Eligibility;
  score: number | null;
  notes: string[];
}

export interface DecisionAlternative {
  id: string;
  label: string;
  eligibility: Eligibility;
  reason: string;
}

export interface EvidenceItem {
  label: string;
  value: string;
  evidenceType: EvidenceType;
}

/**
 * The standard, explainable decision record every technology-selection phase
 * is presented in (spec §3, §16, §17, §24). Built by adapters from each
 * phase's existing deliverable - the deliverables themselves are unchanged.
 */
export interface DecisionRecord {
  phase: PhaseKey;
  title: string;
  source: { deliverableId: string; version: number; createdAt: Date };
  status: 'decided' | 'tied' | 'conditional' | 'not_feasible';
  recommendation: { id: string; label: string } | null;
  confidence: 'high' | 'medium' | 'low' | 'not_assessed';
  why: string[];
  candidates: DecisionCandidate[];
  /** At most two, and never a candidate that failed a mandatory requirement (spec §17). */
  alternatives: DecisionAlternative[];
  tradeoffs: string[];
  risks: string[];
  assumptions: Array<{ statement: string; evidenceType: EvidenceType }>;
  evidence: EvidenceItem[];
  benchmarkRequired: string[];
  wouldChangeIf: string[];
  /** Parts of the spec's decision framework this phase cannot answer yet, and when they arrive. */
  gaps: string[];
}

// ------------------------------------------------------------ central state

export type SectionStatus = LineageStatus | 'not_yet_available';

export interface StateSection {
  status: SectionStatus;
  coverage: 'full' | 'partial' | 'none';
  source: { phase: PhaseKey; version: number; createdAt: Date } | null;
  summary: Record<string, unknown>;
  plannedWave?: number;
}

/** Spec §23 central assessment state. */
export interface AssessmentState {
  useCase: StateSection;
  scale: StateSection;
  data: StateSection;
  embedding: StateSection;
  vectorDB: StateSection;
  index: StateSection;
  model: StateSection;
  inference: StateSection;
  infrastructure: StateSection;
  rag: StateSection;
  security: StateSection;
  performance: StateSection;
  cost: StateSection;
  operations: StateSection;
  recommendation: StateSection;
}

export type StepStatus = 'current' | 'stale' | 'review' | 'in_progress' | 'not_started' | 'not_yet_available';

export interface StepState extends StepDefinition {
  status: StepStatus;
  phaseStatuses: Array<{ phase: PhaseKey; label: string; route: string; status: LineageStatus }>;
}

export interface AiFactoryOverview {
  rulesVersion: string;
  steps: StepState[];
  phases: PhaseLineage[];
  state: AssessmentState;
}

export interface SnapshotComparison {
  from: number;
  to: number;
  sections: Array<{ section: keyof AssessmentState; change: 'unchanged' | 'changed'; statusFrom: SectionStatus; statusTo: SectionStatus; changedFields: string[] }>;
}
