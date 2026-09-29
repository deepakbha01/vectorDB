import { Eligibility } from '../ai-factory.types';
import { ScoreContribution } from '../eligibility/score-breakdown';

export type ModelFamily = 'open_weight' | 'proprietary_api';
export type ModelCapability = 'tool_calling' | 'structured_output' | 'multilingual' | 'vision' | 'code';
export type Level = 'low' | 'medium' | 'high';
export type AccuracyRequirement = 'standard' | 'high' | 'critical';
export type FineTuning = 'none' | 'adapter' | 'full';

export interface CatalogueModel {
  id: string;
  label: string;
  family: ModelFamily;
  category: 'slm' | 'llm' | 'reasoning';
  paramsB?: number;
  contextWindow: number;
  capabilities: ModelCapability[];
  qualityTier: number;
  reasoningTier: number;
  latencyTier: number;
  costTier: number;
  licence: string;
  fineTunable: boolean;
  inferenceModelId?: string;
  managedApiTierId?: string;
}

export interface LicenceTerms {
  label: string;
  permissive: boolean;
  note: string;
}

export interface ModelCatalogue {
  rulesVersion: string;
  licences: Record<string, LicenceTerms>;
  models: CatalogueModel[];
  scoringWeights: Record<'quality' | 'reasoning' | 'latency' | 'cost' | 'contextHeadroom' | 'deploymentFlexibility', number>;
  priorityMultiplier: number;
  accuracyMinQualityTier: Record<AccuracyRequirement, number>;
  reasoningMinTier: Record<Level, number>;
  confidenceMargin: number;
}

/** Model requirements (spec §7 inputs) after defaults from the AI Workload Profile were applied. */
export interface ModelRequirements {
  requiredContextTokens: number;
  reasoningComplexity: Level;
  accuracyRequirement: AccuracyRequirement;
  multilingual: boolean;
  multimodal: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  codeGeneration: boolean;
  fineTuning: FineTuning;
  selfHostingRequired: boolean;
  permissiveLicenceOnly: boolean;
  maxSelfHostedParamsB?: number;
  restrictedData: boolean;
  latencyPriority: Level;
  costPriority: Level;
  domain?: string;
}

export interface EvaluatedModel {
  id: string;
  label: string;
  family: ModelFamily;
  eligibility: Eligibility;
  /** Mandatory requirements this model fails (→ not eligible). */
  failures: string[];
  /** Requirements met only with validation or contractual conditions (→ conditional). */
  conditions: string[];
  notes: string[];
  /** Mandatory requirements this model meets - why it is eligible (absent on results saved before this was added). */
  passed?: string[];
  score: number;
  criteria: Record<string, number>;
  /** Each criterion's value x weight, largest first (absent on older saved results). */
  scoreBreakdown?: ScoreContribution[];
  inferenceModelId?: string;
  managedApiTierId?: string;
}

export interface ModelSelectionResult {
  rulesVersion: string;
  primary: EvaluatedModel | null;
  secondary: EvaluatedModel | null;
  fallback: EvaluatedModel | null;
  roles: { secondary: string | null; fallback: string | null };
  confidence: 'high' | 'medium' | 'low';
  candidates: EvaluatedModel[];
  why: string[];
  tradeoffs: string[];
  wouldChangeIf: string[];
  benchmarkRequired: string[];
  weightsUsed: Record<string, number>;
}
