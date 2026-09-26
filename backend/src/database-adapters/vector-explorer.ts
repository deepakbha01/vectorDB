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

export interface ExplorerPage {
  records: ExplorerRecord[];
  /** Opaque; pass back to get the next page. Null on the last page. */
  nextCursor: string | null;
}

/** Exact-match conditions on metadata fields - the portable subset every phase-1 database supports. */
export type ExplorerFilter = Record<string, string | number | boolean>;

export interface BrowseOptions {
  limit: number;
  cursor: string | null;
  filter: ExplorerFilter;
  /** Include each record's whole vector (for the embedding map). */
  withVectors?: boolean;
}

export interface VectorExplorer {
  listCollections(): Promise<string[]>;
  describeCollection(name: string): Promise<ExplorerCollectionInfo>;
  browse(name: string, options: BrowseOptions): Promise<ExplorerPage>;
  searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]>;
  /**
   * What the design's collection name becomes in this database (Weaviate
   * capitalises class names, Pinecone uses hyphens, Oracle upper-cases).
   * Absent: the name is used as is.
   */
  designedName?(designName: string): string;
}

export function isExplorable(adapter: VectorDatabaseAdapter): adapter is VectorDatabaseAdapter & VectorExplorer {
  const a = adapter as Partial<VectorExplorer>;
  return typeof a.listCollections === 'function' && typeof a.describeCollection === 'function' && typeof a.browse === 'function' && typeof a.searchFiltered === 'function';
}
