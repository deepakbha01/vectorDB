export interface EmbeddingRequest {
  providerId: string;
  modelId: string;
  dimension: number;
  text: string;
}

export interface EmbeddingResult {
  vector: number[];
  /** True when a real provider API produced this vector; false for the offline stand-in. */
  isLiveProvider: boolean;
}
