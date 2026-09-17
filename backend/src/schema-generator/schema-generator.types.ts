export type MetadataFieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface MetadataFieldDefinition {
  name: string;
  type: MetadataFieldType;
}

export interface SchemaGenerationInput {
  collectionName: string;
  dimension: number;
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
