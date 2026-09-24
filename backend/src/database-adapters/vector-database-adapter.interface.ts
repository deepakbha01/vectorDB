import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { IndexTuningParameter } from '../schema-generator/schema-generator.types';
import { SimilarityMetric } from '../discovery/enums/discovery.enum';

/**
 * Common contract every target vector database (Oracle, PostgreSQL+pgvector, Milvus)
 * implements. The Implementation/Ingestion/Operations engines (Phase 4-7) depend only
 * on this interface, never on a concrete database - keeping platforms pluggable per
 * development rule #4.
 *
 * Implemented for real starting Sprint 5 (Phase 4 - Implementation & Provisioning);
 * `upsert`/`search` are minimal here and are built out fully by the Sprint 6
 * ingestion pipeline (Phase 5), which owns batching/retry/dead-letter handling.
 */
export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

export interface VectorSearchQuery {
  vector: number[];
  topK: number;
  filter?: Record<string, unknown>;
  /**
   * Runtime, per-query search-time tuning (e.g. `{ efSearch: 200 }` for HNSW,
   * `{ nprobe: 32 }` for IVF-Flat/PQ) - used by the Phase 6 benchmark harness
   * (Sprint 7) to compare configurations without rebuilding the index, since
   * these are search-time, not build-time, parameters. Postgres and Milvus
   * apply them; Oracle does not yet expose a documented per-query equivalent
   * (see OracleVectorAdapter) and ignores this field.
   */
  searchParams?: Record<string, number>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SchemaDefinition {
  collectionOrTableName: string;
  dimension: number;
  /** Defaults to cosine when omitted - the Phase 4 deployment/benchmark call sites always pass the real value from the Data Pipeline Design / Index Design. */
  metric?: SimilarityMetric;
  metadataFields: Array<{ name: string; type: string }>;
}

export interface VectorDatabaseAdapter {
  readonly platformId:
    | 'oracle'
    | 'postgres_pgvector'
    | 'milvus'
    | 'pinecone'
    | 'qdrant'
    | 'weaviate'
    | 'chroma'
    | 'elasticsearch'
    | 'redis'
    | 'mongodb_atlas'
    | 'lancedb'
    | 'actian';

  healthCheck(): Promise<boolean>;
  createSchema(definition: SchemaDefinition): Promise<void>;

  /** Executes the Phase 3 Index Design's decision + tuned parameters for real (see SchemaGeneratorService.generateIndexArtifact). `metric` defaults to cosine when omitted. */
  createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void>;

  upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void>;
  search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]>;
  deleteById(collectionOrTableName: string, ids: string[]): Promise<void>;

  /**
   * Drops the table/collection. Per development rule "Never perform destructive
   * infrastructure/database operations without explicit confirmation," every
   * implementation MUST reject the call unless `confirm` is exactly `true` -
   * there is no default and no way to opt out of the check.
   */
  dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void>;
}
