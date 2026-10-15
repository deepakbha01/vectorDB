import { AssessmentState, DecisionRecord, Eligibility, PhaseKey, PhaseLineage } from '../ai-factory.types';

export type StageStatus = 'pass' | 'pass_with_conditions' | 'further_assessment' | 'fail';
export type Readiness = 'production_ready' | 'ready_with_conditions' | 'further_assessment' | 'not_suitable';
export type GateStageKey = 'data' | 'requirements' | 'security' | 'technology' | 'performance' | 'cost' | 'operations';

/** Everything the final recommendation combines - the AI Factory's own view of the project. */
export interface FinalInputs {
  projectName: string;
  state: AssessmentState;
  lineage: PhaseLineage[];
  decisions: DecisionRecord[];
  /** Token Observability enabled: the cost stage then also weighs token evidence. Off = unchanged behaviour. */
  tokenObservability?: boolean;
  /** Next-generation hardware facts for the roadmap; absent = no roadmap. */
  roadmap?: RoadmapFacts;
}

export interface GateStage {
  stage: GateStageKey;
  label: string;
  status: StageStatus;
  reasons: string[];
  phases: PhaseKey[];
}

export interface TechnicalRecommendation {
  phase: PhaseKey;
  title: string;
  recommendation: string | null;
  status: DecisionRecord['status'];
  confidence: DecisionRecord['confidence'];
  outOfDate: boolean;
  why: string[];
  satisfied: string[];
  partiallySatisfied: string[];
  notSatisfied: string[];
  tradeoffs: string[];
  assumptions: string[];
  evidence: string[];
  benchmarkRequired: string[];
  wouldChangeIf: string[];
}

export interface ArchitectureAlternative {
  label: string;
  replaces: string;
  eligibility: Eligibility;
  strengths: string[];
  limitations: string[];
  deployment: string;
  costConsiderations: string;
  risks: string[];
  whenToChoose: string;
  sourcePhase: PhaseKey;
}

export interface ChainStep {
  step: string;
  component: string;
  source: PhaseKey | null;
  status: 'current' | 'stale' | 'missing';
}

export interface AdrSection {
  number: number;
  title: string;
  lines: string[];
  source: PhaseKey | null;
  status: 'current' | 'stale' | 'missing';
}

export interface FinalResult {
  rulesVersion: string;
  readiness: { status: Readiness; label: string; reasons: string[]; stages: GateStage[] };
  executiveSummary: {
    useCase: string;
    recommendedArchitecture: string;
    deployment: string;
    primaryModel: string;
    vectorDb: string;
    inferenceArchitecture: string;
    estimatedScale: string;
    keyRisks: string[];
    confidence: 'high' | 'medium' | 'low';
  };
  technical: TechnicalRecommendation[];
  architecture: ChainStep[];
  alternatives: { primary: string; options: ArchitectureAlternative[]; note: string | null };
  adr: AdrSection[];
  implementationPlan: Record<'build' | 'deploy' | 'benchmark' | 'secure' | 'operate' | 'scale', string[]>;
  gaps: string[];
  /** Hardware not yet generally available that would change the design - never part of the verdict. Absent on results saved before it. */
  roadmap?: { items: RoadmapItem[]; note: string } | null;
}

export interface RoadmapItem {
  title: string;
  /** What the design uses today. */
  today: string;
  nextGeneration: string;
  /** What changes - GPUs, cost, latency. */
  impact: string;
  availability: string;
  /** What has to be in place before it can be adopted. */
  prerequisites: string[];
  source: PhaseKey;
}

/** Next-generation facts from the latest Inference and Infrastructure records, gathered by the service. */
export interface RoadmapFacts {
  nextGeneration: {
    inferenceVersion: number;
    today: string;
    option: string;
    precision: string;
    meetsTargets: boolean;
    comparison: string;
    availabilityNote: string;
    rackSystem: { label: string; rackPowerKw: number; rackPowerEstimated: boolean; cooling: 'liquid' | 'air'; cpuLabel: string } | null;
  } | null;
  /** Set only when the chosen on-premises host CPU is not yet generally available. */
  previewHostCpu: { infrastructureVersion: number; label: string; availabilityNote: string } | null;
}
