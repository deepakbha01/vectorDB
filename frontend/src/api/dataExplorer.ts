/** Data Explorer - mirrors backend/src/data-explorer/* and database-adapters/vector-explorer.ts. */

export interface ExplorerStatus {
  platform: string;
  designedCollection: string | null;
  supported: boolean;
  connected: boolean;
  message: string | null;
}

export interface ExplorerCollections {
  designedCollection: string | null;
  collections: Array<{ name: string; designed: boolean }>;
}

export interface ExplorerCollectionInfo {
  name: string;
  recordCount: number | null;
  countIsEstimate: boolean;
  dimension: number | null;
  metric: string | null;
  indexes: Array<{ type: string; detail: string }>;
  fields: Array<{ name: string; type: string }>;
  notes: string[];
}

export type CheckStatus = 'match' | 'mismatch' | 'info' | 'unknown';
export interface DesignCheck {
  key: string;
  label: string;
  designed: string;
  actual: string;
  status: CheckStatus;
  source: string;
  note: string | null;
}

export interface ExplorerOverview {
  platform: string;
  info: ExplorerCollectionInfo;
  checks: DesignCheck[];
}

export interface ExplorerRecord {
  id: string;
  metadata: Record<string, unknown>;
  vectorPreview: number[] | null;
  dimension: number | null;
}

export interface ExplorerDocuments {
  collection: string;
  limit: number;
  rows: ExplorerRecord[];
  nextCursor: string | null;
}

export interface ExplorerSearchResult {
  collection: string;
  topK: number;
  results: Array<{ id: string; score: number; metadata: Record<string, unknown> }>;
  latencyMs: number;
  targetP95LatencyMs: number | null;
  withinTarget: boolean | null;
  embedding: { providerId: string; modelId: string; live: boolean } | null;
  notes: string[];
}
