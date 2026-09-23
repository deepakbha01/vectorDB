export type EmbeddingModelStatus = 'active' | 'deprecated' | 'retired';

export interface EmbeddingModelCatalogEntry {
  id: string;
  label: string;
  dimension: number;
  maxInputTokens: number;
  costPerMillionTokens: number;
  languageSupport: string[];
  qualityTier: string;
  modelVersion: string;
  /** Lifecycle status (spec S8.3) - 'retired' models are rejected at selection time; 'deprecated' warns but is not blocked. */
  status: EmbeddingModelStatus;
  region?: string;
  evidence?: string;
  lastVerifiedDate?: string;
}

export interface EmbeddingProviderCatalogEntry {
  id: string;
  label: string;
  models: EmbeddingModelCatalogEntry[];
}

export interface ResolvedEmbeddingModel extends EmbeddingModelCatalogEntry {
  providerId: string;
  providerLabel: string;
}
