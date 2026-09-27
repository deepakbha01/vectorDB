/** Data Explorer - mirrors backend/src/data-explorer/* and database-adapters/vector-explorer.ts. */

export interface ExplorerStatus {
  platform: string;
  designedCollection: string | null;
  supported: boolean;
  connected: boolean;
  message: string | null;
  /** Whether the project uses its own connection or the server's TARGET_* settings. */
  connectionSource?: 'project' | 'server';
}

/** A project's own connection. Secret values never come back - only whether they are set. */
export interface ConnectionView {
  platform: string;
  source: 'project' | 'server';
  encryptionAvailable: boolean;
  inactiveProfileFor: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  fields: Array<{ key: string; label: string; secret: boolean; required: boolean; hint?: string; set: boolean; value: string | null }>;
}

export interface ConnectionTestResult {
  source: 'project' | 'server' | 'unsaved';
  connected: boolean;
  latencyMs: number;
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
  /** Named vectors (Qdrant, Weaviate); absent for a single vector. */
  vectors?: Array<{ name: string; dimension: number | null; metric: string | null }>;
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
  capabilities?: { keyword: { supported: boolean; ranking: string | null }; sort?: boolean };
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
  mode: 'dense' | 'keyword' | 'hybrid';
  alpha: number | null;
  keywordRanking: string | null;
  topK: number;
  /** denseRank / keywordRank are set for hybrid results. */
  results: Array<{ id: string; score: number; metadata: Record<string, unknown>; denseRank?: number | null; keywordRank?: number | null }>;
  stats?: { count: number; max: number | null; min: number | null; mean: number | null; median: number | null; topGap: number | null };
  latencyMs: number;
  targetP95LatencyMs: number | null;
  withinTarget: boolean | null;
  embedding: { providerId: string; modelId: string; live: boolean } | null;
  notes: string[];
}

export interface ExplorerMap {
  collection: string;
  method: 'pca' | 'umap' | 'tsne';
  dims?: 2 | 3;
  vectorName?: string | null;
  requested: number;
  sampled: number;
  dimension: number | null;
  colorBy: string | null;
  groups: Array<{ value: string; count: number }>;
  points: Array<{ id: string; x: number; y: number; z?: number; group: string | null }>;
  explainedVariance: number[] | null;
  notes: string[];
}

/** One record in full. */
export interface ExplorerRecordDetail {
  collection: string;
  id: string;
  metadata: Record<string, unknown>;
  dimension: number | null;
  vectorHead: number[] | null;
  norm: number | null;
}

/** The same query run two ways. */
export interface ExplorerCompareResult {
  collection: string;
  a: ExplorerSearchResult;
  b: ExplorerSearchResult;
  overlap: { shared: number; onlyA: string[]; onlyB: string[]; jaccard: number; rankShifts: Array<{ id: string; rankA: number; rankB: number; moved: number }> };
}
