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
  /** Tenants or namespaces, where the collection has them. */
  partitions?: ExplorerPartitions;
}

/** Dense (floats), sparse (index → weight, e.g. SPLADE / BM25 vectors) or binary (bits). */
export type VectorKind = 'dense' | 'sparse' | 'binary';

/** A sparse vector: parallel lists of 0-based indices and their weights. */
export interface SparseVector {
  indices: number[];
  values: number[];
}

/** One named vector space of a collection. */
export interface ExplorerVectorSpace {
  name: string;
  /** Dense: components; binary: bits; sparse: the index space, when the database states it. */
  dimension: number | null;
  metric: string | null;
  /** Absent means dense. */
  kind?: VectorKind;
}

/**
 * Tenants (Weaviate multi-tenancy) or namespaces (Pinecone): separate sets of
 * records inside one collection. Browse, search and record reads take one.
 */
export interface ExplorerPartitions {
  kind: 'tenant' | 'namespace';
  /** Up to MAX_PARTITIONS names. */
  names: string[];
  /** Records per name, where the database reports it. */
  counts?: Record<string, number>;
  /** True when every read must name one (Weaviate multi-tenant collections). */
  required: boolean;
  /** More exist than are listed. */
  truncated?: boolean;
}

export const MAX_PARTITIONS = 200;

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
  /** Absent means dense. */
  kind?: VectorKind;
  /** A sparse vector: how many entries are set, and the heaviest 64 (index, weight). */
  sparse?: { nonZero: number; top: Array<{ index: number; value: number }> };
  /** A binary vector: bits set, and the first 256 bits as 0/1 text. */
  bits?: { length: number; ones: number; head: string };
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

/** A listing is ordered by at most this many fields. */
export const MAX_SORT_FIELDS = 3;

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
  /** Only where the database can order a listing (supportsSort): up to MAX_SORT_FIELDS, most significant first. */
  sort?: ExplorerSort[];
  /** Which named vector to return (collections with several); default the first. */
  vectorName?: string;
  /** Tenant / namespace to read (see ExplorerPartitions). */
  partition?: string;
}

/**
 * A similarity search. `vector` is dense floats, or for a binary space its
 * bits (0/1); `sparse` is set instead for a sparse space.
 */
export interface ExplorerVectorQuery {
  vector: number[];
  sparse?: SparseVector;
  topK: number;
  filter: ExplorerFilter;
  /** Which named vector to search (collections with several); default the first. */
  vectorName?: string;
  partition?: string;
}

export interface ExplorerKeywordQuery {
  text: string;
  topK: number;
  filter: ExplorerFilter;
  partition?: string;
}

/** A hybrid search run by the database itself (Weaviate hybrid, Elasticsearch RRF retriever). */
export interface ExplorerNativeHybridQuery {
  text: string;
  vector: number[];
  /** 1 = vector only, 0 = keyword only. */
  alpha: number;
  topK: number;
  filter: ExplorerFilter;
  vectorName?: string;
  partition?: string;
}

export interface RecordReadOptions {
  vectorName?: string;
  partition?: string;
}

export interface VectorExplorer {
  listCollections(): Promise<string[]>;
  /** partition: a tenant / namespace to count and sample, where the collection has them. */
  describeCollection(name: string, partition?: string): Promise<ExplorerCollectionInfo>;
  browse(name: string, options: BrowseOptions): Promise<ExplorerPage>;
  searchFiltered(name: string, query: ExplorerVectorQuery): Promise<VectorSearchResult[]>;
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
  keywordSearch?(name: string, query: ExplorerKeywordQuery): Promise<VectorSearchResult[]>;
  /** How this database ranks keyword search, for the UI (e.g. "Elasticsearch BM25 over text fields"). */
  readonly keywordRanking?: string;
  /** One record by id, or null when there is none. */
  getRecord?(name: string, id: string, options?: RecordReadOptions): Promise<ExplorerRecordDetail | null>;
  /**
   * Hybrid search fused by the database itself. Present only where the
   * database has it; the service otherwise fuses dense and keyword results.
   */
  nativeHybrid?(name: string, query: ExplorerNativeHybridQuery): Promise<VectorSearchResult[]>;
  /** How the database fuses a native hybrid search, for the UI. */
  readonly nativeHybridRanking?: string;
  /** Vector kinds besides dense that searchFiltered can search. */
  readonly searchableKinds?: VectorKind[];
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

/**
 * Weighted score fusion: each list's scores are rescaled to 0-1 (min-max),
 * then score = α·dense + (1-α)·keyword, a record missing from a list scoring
 * 0 there. Unlike rank fusion it keeps how far apart the scores are - and so
 * is swayed by outliers.
 */
export function fuseWeighted(dense: VectorSearchResult[], keyword: VectorSearchResult[], alpha: number, topK: number): FusedResult[] {
  const a = Math.min(1, Math.max(0, alpha));
  const scale = (list: VectorSearchResult[]) => {
    const s = list.map((r) => r.score);
    const lo = Math.min(...s);
    const hi = Math.max(...s);
    return (x: number) => (hi > lo ? (x - lo) / (hi - lo) : 1);
  };
  const d = scale(dense);
  const kw = scale(keyword);
  const byId = new Map<string, FusedResult>();
  dense.forEach((r, i) => byId.set(r.id, { ...r, score: a * d(r.score), denseRank: i + 1, keywordRank: null }));
  keyword.forEach((r, i) => {
    const hit = byId.get(r.id);
    const add = (1 - a) * kw(r.score);
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
