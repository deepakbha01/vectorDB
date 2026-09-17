export interface EmbeddingModelCatalogEntry {
  id: string;
  label: string;
  dimension: number;
  maxInputTokens: number;
  costPerMillionTokens: number;
  languageSupport: string[];
  qualityTier: string;
  modelVersion: string;
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
