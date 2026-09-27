import { VectorDatabaseAdapter, VectorSearchResult } from './vector-database-adapter.interface';

/**
 * Read-only exploration of a target vector database (Data Explorer). Every
 * live adapter implements it; one without it (Actian - no Node.js driver) is
 * shown as "not supported". Nothing here writes, loads or changes the target.
 */

export interface ExplorerField {
  name: string;
  /** The database's own type name (e.g. "text", "keyword", "VarChar"). */
  type: string;
}

export interface ExplorerIndex {
  /** Normalised: hnsw | ivf_flat | pq | managed (chosen by the service, e.g. Pinecone) | other. */
  type: string;
  /** The database's own description of it (index definition, parameters). */
  detail: string;
}

export interface ExplorerCollectionInfo {
  name: string;
  recordCount: number | null;
  /** True when the count comes from table statistics rather than an exact count. */
  countIsEstimate: boolean;
  dimension: number | null;
  /** Normalised SimilarityMetric value (cosine | dot_product | euclidean) when the database states one. */
  metric: string | null;
  indexes: ExplorerIndex[];
  /** Metadata / payload fields - not the id or the vector. */
  fields: ExplorerField[];
  /** Anything the reader should know about these figures (e.g. "no pgvector: array column"). */
  notes: string[];
  /**
   * Named vectors (Qdrant, Weaviate): every vector space a record carries.
   * dimension and metric above describe the first; the others can be chosen
   * for search, the map and the record view. Absent for a single vector.
   */
  vectors?: ExplorerVectorSpace[];
}

/** One named vector space of a collection. */
export interface ExplorerVectorSpace {
  name: string;
  dimension: number | null;
  metric: string | null;
}

export interface ExplorerRecord {
  id: string;
  metadata: Record<string, unknown>;
  /** The first few components only - enough to recognise a vector, not to copy it. */
  vectorPreview: number[] | null;
  dimension: number | null;
  /** The whole vector - only when browse is asked for it (the embedding map); never sent to the browser. */
  vector?: number[];
}

/** One record in full (the detail view). */
export interface ExplorerRecordDetail {
  id: string;
  metadata: Record<string, unknown>;
  dimension: number | null;
  /** The first 64 vector values. */
  vectorHead: number[] | null;
  /** L2 norm - about 1 for normalised embeddings. */
  norm: number | null;
}

export interface ExplorerPage {
  records: ExplorerRecord[];
  /** Opaque; pass back to get the next page. Null on the last page. */
  nextCursor: string | null;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
export type FilterValue = string | number | boolean;

/** One condition on a metadata field: = ≠ > ≥ < ≤, or "in" a list. */
export interface FilterCondition {
  field: string;
  op: FilterOp;
  value: FilterValue | FilterValue[];
}

/** Conditions that must all hold ('and') or any of which may hold ('or'). */
export interface ExplorerFilter {
  combine: 'and' | 'or';
  conditions: FilterCondition[];
}

export const NO_FILTER: ExplorerFilter = { combine: 'and', conditions: [] };

/** Sort a record listing by a metadata field. */
export interface ExplorerSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface BrowseOptions {
  limit: number;
  cursor: string | null;
  filter: ExplorerFilter;
  /** Include each record's whole vector (for the embedding map). */
  withVectors?: boolean;
  /** Only where the database can order a listing (supportsSort). */
  sort?: ExplorerSort;
  /** Which named vector to return (collections with several); default the first. */
  vectorName?: string;
}

export interface VectorExplorer {
  listCollections(): Promise<string[]>;
  describeCollection(name: string): Promise<ExplorerCollectionInfo>;
  browse(name: string, options: BrowseOptions): Promise<ExplorerPage>;
  /** vectorName: which named vector to search (collections with several); default the first. */
  searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter; vectorName?: string }): Promise<VectorSearchResult[]>;
  /**
   * What the design's collection name becomes in this database (Weaviate
   * capitalises class names, Pinecone uses hyphens, Oracle upper-cases).
   * Absent: the name is used as is.
   */
  designedName?(designName: string): string;
  /**
   * Keyword (lexical) search ranked by the database itself - BM25 or its
   * equivalent. Present only where the database ranks text natively; the
   * hybrid mode fuses it with dense search in the service.
   */
  keywordSearch?(name: string, query: { text: string; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]>;
  /** How this database ranks keyword search, for the UI (e.g. "Elasticsearch BM25 over text fields"). */
  readonly keywordRanking?: string;
  /** One record by id, or null when there is none. */
  getRecord?(name: string, id: string, vectorName?: string): Promise<ExplorerRecordDetail | null>;
  /** True where browse can order records by a field. */
  readonly supportsSort?: boolean;
}

/** A result of a hybrid search: the fused score and where the record ranked in each list. */
export interface FusedResult extends VectorSearchResult {
  denseRank: number | null;
  keywordRank: number | null;
}

/**
 * Weighted Reciprocal Rank Fusion: score = α/(k + dense rank) + (1-α)/(k + keyword rank),
 * a missing rank adding nothing. Ranks, not raw scores, are fused - dense
 * similarities and BM25 scores are on different scales. k = 60 is the usual constant.
 */
export function fuseResults(dense: VectorSearchResult[], keyword: VectorSearchResult[], alpha: number, topK: number, k = 60): FusedResult[] {
  const a = Math.min(1, Math.max(0, alpha));
  const byId = new Map<string, FusedResult>();
  dense.forEach((r, i) => byId.set(r.id, { ...r, score: a / (k + i + 1), denseRank: i + 1, keywordRank: null }));
  keyword.forEach((r, i) => {
    const hit = byId.get(r.id);
    const add = (1 - a) / (k + i + 1);
    if (hit) {
      hit.score += add;
      hit.keywordRank = i + 1;
      hit.metadata = { ...r.metadata, ...hit.metadata };
    } else byId.set(r.id, { ...r, score: add, denseRank: null, keywordRank: i + 1 });
  });
  return [...byId.values()].sort((x, y) => y.score - x.score || (x.denseRank ?? 1e9) - (y.denseRank ?? 1e9)).slice(0, topK);
}

export function isExplorable(adapter: VectorDatabaseAdapter): adapter is VectorDatabaseAdapter & VectorExplorer {
  const a = adapter as Partial<VectorExplorer>;
  return typeof a.listCollections === 'function' && typeof a.describeCollection === 'function' && typeof a.browse === 'function' && typeof a.searchFiltered === 'function';
}
