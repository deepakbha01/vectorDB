import { SimilarityMetric } from '../discovery/enums/discovery.enum';

export type MetadataFieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';

/**
 * Column names every generator below already reserves for the fixed
 * id/embedding/created_at columns - a metadata field may not reuse one of
 * these, and no two metadata fields may share a name (see
 * DataPipelineDesignService.submitDesign, which validates both before this
 * type ever reaches the generator).
 */
export const RESERVED_METADATA_FIELD_NAMES = ['id', 'embedding', 'created_at'] as const;

export interface MetadataFieldDefinition {
  name: string;
  type: MetadataFieldType;
  /** Ingestion should reject a record missing this field. Not yet enforced at Phase 5 runtime - captured here for the design record/report only. */
  required?: boolean;
  /** Whether this field should be indexed for filtering/pre-filtering. Defaults to true (matches every platform's current unconditional-index behavior) when omitted. */
  filterable?: boolean;
  /** Whether this field participates in full-text/keyword search (hybrid search), as distinct from vector similarity. */
  searchable?: boolean;
  /** Whether queries may sort/order by this field. */
  sortable?: boolean;
  description?: string;
}

export interface SchemaGenerationInput {
  collectionName: string;
  dimension: number;
  /** Defaults to cosine when omitted - always pass the real Discovery-sourced value on the customer-facing path (Phase 2 submitDesign). */
  metric?: SimilarityMetric;
  metadataFields: MetadataFieldDefinition[];
}

/** SQL (or SQL-like command text, e.g. Redis's FT.CREATE) schema output. */
export interface SqlSchemaOutput {
  ddl: string;
  notes: string[];
}

/** JSON/API-config-based schema output (createCollection/createIndex request bodies, etc.). */
export interface JsonConfigSchemaOutput {
  schema: Record<string, unknown>;
  notes: string[];
}

/** @deprecated kept as an alias for existing call sites; identical shape to JsonConfigSchemaOutput. */
export type MilvusSchemaOutput = JsonConfigSchemaOutput;

export interface GeneratedSchemas {
  oracle: SqlSchemaOutput;
  postgres_pgvector: SqlSchemaOutput;
  milvus: JsonConfigSchemaOutput;
  pinecone: JsonConfigSchemaOutput;
  qdrant: JsonConfigSchemaOutput;
  weaviate: JsonConfigSchemaOutput;
  chroma: JsonConfigSchemaOutput;
  elasticsearch: JsonConfigSchemaOutput;
  redis: SqlSchemaOutput;
  mongodb_atlas: JsonConfigSchemaOutput;
  lancedb: JsonConfigSchemaOutput;
  actian: SqlSchemaOutput;
}

export interface IndexTuningParameter {
  name: string;
  value: number;
}

export interface IndexArtifact {
  /** SQL/command text for SQL-like platforms; a JSON-stringified index-config object for API/SDK-based platforms. */
  statement: string;
  notes: string[];
}
