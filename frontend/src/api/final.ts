/** Final AI Architecture Recommendation (AI Factory Wave 11) - mirrors backend/src/ai-factory/final/*. */
import { Eligibility } from './aiFactory';

export type StageStatus = 'pass' | 'pass_with_conditions' | 'further_assessment' | 'fail';
export type Readiness = 'production_ready' | 'ready_with_conditions' | 'further_assessment' | 'not_suitable';
type Presence = 'current' | 'stale' | 'missing';

export interface FinalResult {
  rulesVersion: string;
  readiness: { status: Readiness; label: string; reasons: string[]; stages: Array<{ stage: string; label: string; status: StageStatus; reasons: string[]; phases: string[] }> };
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
  technical: Array<{
    phase: string;
    title: string;
    recommendation: string | null;
    status: 'decided' | 'tied' | 'conditional' | 'not_feasible';
    confidence: string;
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
  }>;
  architecture: Array<{ step: string; component: string; source: string | null; status: Presence }>;
  alternatives: {
    primary: string;
    options: Array<{ label: string; replaces: string; eligibility: Eligibility; strengths: string[]; limitations: string[]; deployment: string; costConsiderations: string; risks: string[]; whenToChoose: string; sourcePhase: string }>;
    note: string | null;
  };
  adr: Array<{ number: number; title: string; lines: string[]; source: string | null; status: Presence }>;
  implementationPlan: Record<'build' | 'deploy' | 'benchmark' | 'secure' | 'operate' | 'scale', string[]>;
  gaps: string[];
}

export interface FinalRecommendation {
  id: string;
  version: number;
  result: FinalResult;
  createdAt: string;
}
