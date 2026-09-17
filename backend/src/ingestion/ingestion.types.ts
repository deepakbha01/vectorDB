export interface DocumentInput {
  id?: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface IngestionConfig {
  batchSize: number;
  embeddingConcurrency: number;
  retryCount: number;
  retryBackoffMs: number;
  rateLimitPerSecond: number;
}

export interface IngestionMetrics {
  documentsSubmitted: number;
  documentsCorrupted: number;
  chunksProduced: number;
  chunksEmbedded: number;
  chunksDeduplicated: number;
  chunksStored: number;
  chunksDeadLettered: number;
  durationMs: number;
}
