/** Model Selection (AI Factory Wave 3) - mirrors backend/src/ai-factory/model-selection/*. */
import { Eligibility } from './aiFactory';

export interface CreateModelSelectionInput {
  requiredContextTokens?: number;
  reasoningComplexity?: 'low' | 'medium' | 'high';
  accuracyRequirement?: 'standard' | 'high' | 'critical';
  multilingual?: boolean;
  multimodal?: boolean;
  toolCalling?: boolean;
  structuredOutput?: boolean;
  codeGeneration?: boolean;
  fineTuning?: 'none' | 'adapter' | 'full';
  selfHostingRequired?: boolean;
  permissiveLicenceOnly?: boolean;
  maxSelfHostedParamsB?: number;
  latencyPriority?: 'low' | 'medium' | 'high';
  costPriority?: 'low' | 'medium' | 'high';
  domain?: string;
}

export interface EvaluatedModel {
  id: string;
  label: string;
  family: 'open_weight' | 'proprietary_api';
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
  notes: string[];
  score: number;
  criteria: Record<string, number>;
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

export type RequirementSource = { source: 'user' | 'workload_profile' | 'default'; detail: string };

export interface ModelSelection {
  id: string;
  version: number;
  submitted: CreateModelSelectionInput;
  requirements: Required<Omit<CreateModelSelectionInput, 'maxSelfHostedParamsB' | 'domain'>> & { restrictedData: boolean; maxSelfHostedParamsB?: number; domain?: string };
  sources: Record<string, RequirementSource>;
  result: ModelSelectionResult;
  rulesVersion: string;
  createdAt: string;
}

export interface ModelSelectionDefaults {
  requirements: Record<string, unknown>;
  sources: Record<string, RequirementSource>;
  preview: ModelSelectionResult;
}
