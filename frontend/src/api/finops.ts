/** Cost & FinOps (AI Factory Wave 9) - mirrors backend/src/ai-factory/finops/*. */
import { EvidenceType } from './aiFactory';

export type CostCategory = 'inference' | 'vector_db' | 'embedding' | 'infrastructure' | 'operations';
export type CostResource = 'gpu' | 'cpu' | 'storage' | 'network' | 'api' | 'people' | 'other';

export interface CostLine {
  category: CostCategory;
  resource: CostResource;
  item: string;
  monthlyUsd: number;
  evidenceType: Exclude<EvidenceType, 'measured'>;
  basis: string;
}

export interface PricedOption {
  id: string;
  label: string;
  targets: string[];
  allowed: boolean;
  feasible: boolean;
  notFeasibleReasons: string[];
  monthlyUsd: number | null;
  byCategory: Record<CostCategory, number> | null;
  lines: CostLine[];
}

export interface FinopsResult {
  rulesVersion: string;
  ratesReviewed: string;
  disclaimer: string;
  chosen: PricedOption | null;
  comparison: PricedOption[];
  byResource: Record<CostResource, number> | null;
  unitEconomics: Array<{ label: string; usd: number; evidenceType: 'estimated'; basis: string }>;
  oneOff: Array<{ item: string; usd: number; evidenceType: Exclude<EvidenceType, 'measured'>; basis: string }>;
  budget: { monthlyBudgetUsd: number | null; source: string | null; status: 'within_budget' | 'near_budget' | 'exceeds_budget' | 'no_budget'; note: string };
  validation: { status: 'pass_with_conditions' | 'further_assessment' | 'fail'; reasons: string[] };
  cheapestAllowed: { id: string; label: string; monthlyUsd: number } | null;
  gaps: string[];
  wouldChangeIf: string[];
}

export interface FinopsAssessment {
  id: string;
  version: number;
  result: FinopsResult;
  createdAt: string;
}

export interface FinopsDefaults {
  preview: FinopsResult;
}
