import { Eligibility } from '../ai-factory.types';

/**
 * Eligibility layers for choices the existing engines make without one
 * (spec §3). Pure and read-only: they judge an existing deliverable's options
 * against mandatory rules from config/ai-factory.yaml; they never change what
 * the Index Design or Data Pipeline engines decided.
 */

export interface IndexEligibilityRules {
  memoryNotEligibleAbove: number;
  memoryConditionalAbove: number;
  maxTypicalRecall: Record<string, number>;
  recallConditionalMargin: number;
  updateSensitive: Record<string, string[]>;
}

export interface EmbeddingEligibilityRules {
  qualityScore: Record<string, number>;
  selfHostableProviders: string[];
  scoringWeights: { quality: number; cost: number; dimensionEfficiency: number };
  referenceDimension: number;
  charsPerToken: number;
}

export interface EligibilityVerdict {
  eligibility: Eligibility;
  failures: string[];
  conditions: string[];
}

const verdict = (failures: string[], conditions: string[]): EligibilityVerdict => ({
  eligibility: failures.length ? 'not_eligible' : conditions.length ? 'conditional' : 'eligible',
  failures,
  conditions,
});

// ------------------------------------------------------------------ index

export interface IndexOptionFacts {
  indexType: string;
  estimatedMemoryGb: number;
}

export interface IndexContext {
  availableMemoryGb: number;
  recallTarget: number;
  updateFrequency: string;
}

export function indexEligibility(o: IndexOptionFacts, ctx: IndexContext, rules: IndexEligibilityRules): EligibilityVerdict {
  const failures: string[] = [];
  const conditions: string[] = [];
  const memoryRatio = ctx.availableMemoryGb > 0 ? o.estimatedMemoryGb / ctx.availableMemoryGb : Infinity;
  if (memoryRatio > rules.memoryNotEligibleAbove) {
    failures.push(`Needs ~${o.estimatedMemoryGb.toFixed(1)} GB, more than the ${ctx.availableMemoryGb} GB available.`);
  } else if (memoryRatio > rules.memoryConditionalAbove) {
    conditions.push(`Uses ${Math.round(memoryRatio * 100)}% of available memory - little headroom for growth.`);
  }
  const ceiling = rules.maxTypicalRecall[o.indexType];
  if (ceiling !== undefined) {
    if (ctx.recallTarget > ceiling) failures.push(`Recall target ${ctx.recallTarget} is above what this index family typically reaches (~${ceiling}).`);
    else if (ctx.recallTarget > ceiling - rules.recallConditionalMargin) conditions.push(`Recall target ${ctx.recallTarget} is close to this family's typical ceiling (~${ceiling}) - needs aggressive tuning; benchmark it.`);
  }
  if ((rules.updateSensitive[o.indexType] ?? []).includes(ctx.updateFrequency)) {
    conditions.push(`With ${ctx.updateFrequency} update frequency this index needs periodic re-clustering / re-training to keep recall.`);
  }
  return verdict(failures, conditions);
}

// -------------------------------------------------------------- embedding

export interface EmbeddingModelFacts {
  providerId: string;
  modelId: string;
  label: string;
  dimension: number;
  maxInputTokens: number;
  costPerMillionTokens: number;
  languageSupport: string[];
  qualityTier: string;
  status: string;
}

export interface EmbeddingContext {
  chunkTokens: number;
  selfHostingRequired: boolean;
  multilingual: boolean;
}

export function embeddingEligibility(m: EmbeddingModelFacts, ctx: EmbeddingContext, rules: EmbeddingEligibilityRules): EligibilityVerdict {
  const failures: string[] = [];
  const conditions: string[] = [];
  if (m.status === 'retired') failures.push('Model is retired by its provider.');
  else if (m.status === 'deprecated') conditions.push('Model is deprecated - plan a migration and re-embedding.');
  if (m.maxInputTokens < ctx.chunkTokens) failures.push(`Max input ${m.maxInputTokens.toLocaleString()} tokens is below the ~${ctx.chunkTokens.toLocaleString()}-token chunks - text would be truncated.`);
  if (ctx.selfHostingRequired && !rules.selfHostableProviders.includes(m.providerId)) failures.push('Hosted by a third-party API, but embeddings must be generated inside the customer boundary.');
  if (ctx.multilingual && !m.languageSupport.includes('multilingual')) {
    if (m.languageSupport.includes('multilingual-partial')) conditions.push('Only partial multilingual support - evaluate retrieval quality in each required language.');
    else failures.push('English-only, but multilingual support is required.');
  }
  return verdict(failures, conditions);
}

export function scoreEmbedding(m: EmbeddingModelFacts, all: EmbeddingModelFacts[], rules: EmbeddingEligibilityRules): number {
  const quality = rules.qualityScore[m.qualityTier] ?? 0.5;
  // Cost relative to the most expensive candidate (free open-source models score 1).
  const maxCost = Math.max(...all.map((x) => x.costPerMillionTokens), 0.0001);
  const cost = 1 - m.costPerMillionTokens / maxCost;
  const dimensionEfficiency = Math.min(1, rules.referenceDimension / m.dimension);
  const w = rules.scoringWeights;
  return Math.round((quality * w.quality + cost * w.cost + dimensionEfficiency * w.dimensionEfficiency) * 1000) / 1000;
}
