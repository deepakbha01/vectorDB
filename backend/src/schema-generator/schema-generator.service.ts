import { BadRequestException, Injectable } from '@nestjs/common';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { SimilarityMetric } from '../discovery/enums/discovery.enum';
import { sanitizeSqlIdentifier } from '../common/identifier-sanitizer';
import {
  GeneratedSchemas,
  IndexArtifact,
  IndexTuningParameter,
  JsonConfigSchemaOutput,
  MetadataFieldDefinition,
  SchemaGenerationInput,
  SqlSchemaOutput,
} from './schema-generator.types';

type MetricPlatformKey =
  | 'oracle'
  | 'postgres'
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

/**
 * Every platform's native literal for each SimilarityMetric - the single
 * source of truth every generator below reads from instead of assuming
 * cosine. Verify against each vendor's current docs before relying on this
 * for a metric this file hasn't been exercised against in production.
 */
const METRIC_LITERALS: Record<MetricPlatformKey, Record<SimilarityMetric, string>> = {
  oracle: { cosine: 'COSINE', dot_product: 'DOT', euclidean: 'EUCLIDEAN' },
  postgres: { cosine: 'vector_cosine_ops', dot_product: 'vector_ip_ops', euclidean: 'vector_l2_ops' },
  milvus: { cosine: 'COSINE', dot_product: 'IP', euclidean: 'L2' },
  pinecone: { cosine: 'cosine', dot_product: 'dotproduct', euclidean: 'euclidean' },
  qdrant: { cosine: 'Cosine', dot_product: 'Dot', euclidean: 'Euclid' },
  weaviate: { cosine: 'cosine', dot_product: 'dot', euclidean: 'l2-squared' },
  chroma: { cosine: 'cosine', dot_product: 'ip', euclidean: 'l2' },
  elasticsearch: { cosine: 'cosine', dot_product: 'dot_product', euclidean: 'l2_norm' },
  redis: { cosine: 'COSINE', dot_product: 'IP', euclidean: 'L2' },
  mongodb_atlas: { cosine: 'cosine', dot_product: 'dotProduct', euclidean: 'euclidean' },
  lancedb: { cosine: 'cosine', dot_product: 'dot', euclidean: 'l2' },
  actian: { cosine: 'COSINE', dot_product: 'DOT', euclidean: 'EUCLIDEAN' },
};

/**
 * Generates database-specific schemas for every supported platform from the
 * same design-time input (Phase 2 requirement). Reused as-is by the Phase 4
 * Implementation engine (Sprint 5) when the schema is actually deployed -
 * identifiers are sanitized here because that DDL/config will eventually run
 * for real against a live database.
 *
 * Every platform below is fully supported for Phase 2 (this file), Phase 3
 * (generateIndexArtifact), Phase 4 (deployment plan/IaC), and Phase 7
 * (capacity planning) config/text generation. Actian is the one exception at
 * Phase 5 (real ingestion): no maintained Node.js driver exists for it, so
 * ActianVectorAdapter documents that limitation rather than connecting live -
 * everything generated here for Actian is still valid, reviewable SQL.
 */
@Injectable()
export class SchemaGeneratorService {
  private metricLiteral(platform: MetricPlatformKey, metric: SimilarityMetric): string {
    return METRIC_LITERALS[platform][metric];
  }

  generateAll(input: SchemaGenerationInput): GeneratedSchemas {
    const collectionName = sanitizeSqlIdentifier(input.collectionName, 'collectionName');
    const fields = input.metadataFields.map((f) => ({ ...f, name: sanitizeSqlIdentifier(f.name, `metadataField '${f.name}'`) }));
    const metric = input.metric ?? SimilarityMetric.COSINE;

    if (input.dimension <= 0) {
      throw new BadRequestException('dimension must be a positive integer.');
    }

    return {
      oracle: this.generateOracle(collectionName, input.dimension, fields, metric),
      postgres_pgvector: this.generatePostgres(collectionName, input.dimension, fields, metric),
      milvus: this.generateMilvus(collectionName, input.dimension, fields),
      pinecone: this.generatePinecone(collectionName, input.dimension, fields, metric),
      qdrant: this.generateQdrant(collectionName, input.dimension, fields, metric),
      weaviate: this.generateWeaviate(collectionName, input.dimension, fields, metric),
      chroma: this.generateChroma(collectionName, input.dimension, fields, metric),
      elasticsearch: this.generateElasticsearch(collectionName, input.dimension, fields, metric),
      redis: this.generateRedis(collectionName, input.dimension, fields, metric),
      mongodb_atlas: this.generateMongoAtlas(collectionName, input.dimension, fields, metric),
      lancedb: this.generateLanceDb(collectionName, input.dimension, fields),
      actian: this.generateActian(collectionName, input.dimension, fields),
    };
  }

  private sqlColumnType(platform: 'oracle' | 'postgres' | 'actian', type: MetadataFieldDefinition['type']): string {
    const oracleTypes: Record<string, string> = {
      string: 'VARCHAR2(4000)',
      number: 'NUMBER',
      boolean: 'NUMBER(1)',
      date: 'TIMESTAMP',
      json: 'JSON',
    };
    const postgresTypes: Record<string, string> = {
      string: 'TEXT',
      number: 'DOUBLE PRECISION',
      boolean: 'BOOLEAN',
      date: 'TIMESTAMPTZ',
      json: 'JSONB',
    };
    // Actian's ANSI-SQL dialect is closest to Postgres's for these primitive types.
    const actianTypes: Record<string, string> = {
      string: 'VARCHAR(4000)',
      number: 'FLOAT',
      boolean: 'BOOLEAN',
      date: 'TIMESTAMP',
      json: 'VARCHAR(8000)',
    };
    const table = { oracle: oracleTypes, postgres: postgresTypes, actian: actianTypes }[platform];
    return table[type];
  }

  private generateOracle(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): SqlSchemaOutput {
    const tableName = collectionName;
    const columns = fields.map((f) => `  ${f.name} ${this.sqlColumnType('oracle', f.type)}`).join(',\n');
    const distance = this.metricLiteral('oracle', metric);
    const ddl = [
      `CREATE TABLE ${tableName} (`,
      `  id VARCHAR2(64) PRIMARY KEY,`,
      `  embedding VECTOR(${dimension}, FLOAT32) NOT NULL,`,
      columns ? `${columns},` : '',
      `  created_at TIMESTAMP DEFAULT SYSTIMESTAMP`,
      `);`,
      ``,
      `-- Vector index deferred to Phase 3 (Index Design). Example HNSW-style index:`,
      `-- CREATE VECTOR INDEX ${tableName}_vec_idx ON ${tableName}(embedding)`,
      `--   ORGANIZATION INMEMORY NEIGHBOR GRAPH`,
      `--   DISTANCE ${distance}`,
      `--   WITH TARGET ACCURACY 95;`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    return {
      ddl,
      notes: [
        'Requires Oracle Database 23ai or later for the native VECTOR type.',
        'id is a VARCHAR2(64) surrogate key; adjust if your source IDs are natively numeric.',
      ],
    };
  }

  private generatePostgres(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): SqlSchemaOutput {
    const tableName = collectionName;
    const columns = fields.map((f) => `  ${f.name} ${this.sqlColumnType('postgres', f.type)}`).join(',\n');
    const ops = this.metricLiteral('postgres', metric);
    const ddl = [
      `CREATE EXTENSION IF NOT EXISTS vector;`,
      ``,
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
      // TEXT, not UUID: the ingestion pipeline supplies its own composite
      // "documentId::chunkIndex" record IDs (see IngestionService), which
      // are never valid UUIDs.
      `  id TEXT PRIMARY KEY,`,
      `  embedding vector(${dimension}) NOT NULL,`,
      columns ? `${columns},` : '',
      `  created_at TIMESTAMPTZ DEFAULT now()`,
      `);`,
      ``,
      `-- Vector index deferred to Phase 3 (Index Design). Example HNSW index:`,
      `-- CREATE INDEX ${tableName}_embedding_hnsw_idx ON ${tableName}`,
      `--   USING hnsw (embedding ${ops});`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    return {
      ddl,
      notes: ['Requires the pgvector extension (>= 0.5.0 for HNSW support).'],
    };
  }

  private generateMilvus(collectionName: string, dimension: number, fields: MetadataFieldDefinition[]): JsonConfigSchemaOutput {
    const milvusTypes: Record<MetadataFieldDefinition['type'], Record<string, unknown>> = {
      string: { data_type: 'VarChar', max_length: 4000 },
      number: { data_type: 'Double' },
      boolean: { data_type: 'Bool' },
      date: { data_type: 'Int64', description: 'Unix epoch milliseconds - Milvus has no native date type.' },
      json: { data_type: 'JSON' },
    };

    return {
      schema: {
        collection_name: collectionName,
        fields: [
          { name: 'id', data_type: 'VarChar', is_primary_key: true, max_length: 64 },
          { name: 'embedding', data_type: 'FloatVector', dim: dimension },
          ...fields.map((f) => ({ name: f.name, ...milvusTypes[f.type] })),
        ],
      },
      notes: [
        'Index type/params (HNSW, IVF_FLAT, or PQ) are chosen in Phase 3 - Index Design, then applied via createIndex.',
        'Dates are stored as Int64 epoch-millisecond values; convert at ingestion time.',
      ],
    };
  }

  private generatePinecone(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): JsonConfigSchemaOutput {
    return {
      schema: {
        name: collectionName,
        dimension,
        metric: this.metricLiteral('pinecone', metric),
        spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      },
      notes: [
        'Pinecone is schemaless for metadata - fields are not declared upfront; any JSON key/value on upsert becomes filterable.',
        `Metadata fields planned for this collection: ${fields.map((f) => f.name).join(', ') || '(none)'}.`,
        'cloud/region are placeholders - set to match your Pinecone project and data-residency requirements before creating the index.',
        'Pinecone manages the ANN algorithm internally; there is no user-selectable HNSW/IVF/PQ choice (see Phase 3 notes).',
      ],
    };
  }

  private generateQdrant(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): JsonConfigSchemaOutput {
    const qdrantTypes: Record<MetadataFieldDefinition['type'], string> = {
      string: 'keyword',
      number: 'float',
      boolean: 'bool',
      date: 'datetime',
      json: 'keyword',
    };
    const filterableFields = fields.filter((f) => f.filterable !== false);
    return {
      schema: {
        collection: collectionName,
        create_collection_request: {
          vectors: { size: dimension, distance: this.metricLiteral('qdrant', metric) },
        },
        payload_indexes: filterableFields.map((f) => ({ field_name: f.name, field_schema: qdrantTypes[f.type] })),
      },
      notes: [
        'The vectors config creates the collection; each payload_indexes entry is a separate PUT /collections/{name}/index call for efficient filtering.',
        'json fields are indexed as keyword (exact match on the stringified value) - Qdrant has no native JSON/object payload index type.',
        `Fields marked non-filterable are stored in the payload but not indexed: ${fields.filter((f) => f.filterable === false).map((f) => f.name).join(', ') || '(none)'}.`,
      ],
    };
  }

  private generateWeaviate(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): JsonConfigSchemaOutput {
    const weaviateTypes: Record<MetadataFieldDefinition['type'], string> = {
      string: 'text',
      number: 'number',
      boolean: 'boolean',
      date: 'date',
      json: 'text',
    };
    const className = collectionName.charAt(0).toUpperCase() + collectionName.slice(1);
    return {
      schema: {
        class: className,
        vectorizer: 'none', // embeddings are supplied by this platform's own Phase 2 embedding model choice, not Weaviate's built-in vectorizers
        vectorIndexType: 'hnsw',
        vectorIndexConfig: { distance: this.metricLiteral('weaviate', metric) },
        properties: fields.map((f) => ({ name: f.name, dataType: [weaviateTypes[f.type]] })),
      },
      notes: [
        `Weaviate class names must start with an uppercase letter - '${collectionName}' is created as '${className}'.`,
        'json fields are stored as text (stringified) - Weaviate has no native JSON property type.',
        'vectorizer is "none": vectors are supplied at upsert time from this platform\'s embedding pipeline, not computed by Weaviate.',
      ],
    };
  }

  private generateChroma(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): JsonConfigSchemaOutput {
    return {
      schema: {
        name: collectionName,
        metadata: { 'hnsw:space': this.metricLiteral('chroma', metric) },
        embedding_dimension: dimension,
      },
      notes: [
        'Chroma is schemaless for metadata (a free-form dict per record); fields are not declared upfront.',
        `Metadata fields planned for this collection: ${fields.map((f) => f.name).join(', ') || '(none)'}.`,
        'embedding_dimension is informational for this tool\'s own validation - the Chroma client infers dimension from the first vector added.',
      ],
    };
  }

  private generateElasticsearch(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): JsonConfigSchemaOutput {
    const esTypes: Record<MetadataFieldDefinition['type'], string> = {
      string: 'keyword',
      number: 'double',
      boolean: 'boolean',
      date: 'date',
      json: 'object',
    };
    const properties: Record<string, unknown> = {
      embedding: { type: 'dense_vector', dims: dimension, index: true, similarity: this.metricLiteral('elasticsearch', metric) },
    };
    for (const f of fields) {
      properties[f.name] = { type: esTypes[f.type] };
    }
    return {
      schema: { index: collectionName, mappings: { properties } },
      notes: [
        'Requires Elasticsearch >= 8.0 (or an OpenSearch equivalent using the k-NN plugin\'s knn_vector type instead of dense_vector).',
        'string metadata is mapped as keyword (exact match/aggregation); use an additional text sub-field if full-text search over it is needed.',
      ],
    };
  }

  private generateRedis(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): SqlSchemaOutput {
    const redisTypes: Record<MetadataFieldDefinition['type'], string> = {
      string: 'TAG',
      number: 'NUMERIC',
      boolean: 'TAG',
      date: 'NUMERIC',
      json: 'TEXT',
    };
    const filterableFields = fields.filter((f) => f.filterable !== false);
    const fieldLines = filterableFields.map((f) => `    ${f.name} ${redisTypes[f.type]}`);
    const distanceMetric = this.metricLiteral('redis', metric);
    const ddl = [
      `FT.CREATE ${collectionName}_idx ON HASH PREFIX 1 ${collectionName}: SCHEMA`,
      `    id TAG`,
      `    embedding VECTOR HNSW 6 TYPE FLOAT32 DIM ${dimension} DISTANCE_METRIC ${distanceMetric}`,
      ...fieldLines,
    ].join('\n');
    return {
      ddl,
      notes: [
        'Requires the RediSearch module (Redis Stack, or Redis Enterprise with the Search module enabled) - plain open-source Redis has no vector index support.',
        'Records are stored as Redis Hashes under the "<collectionName>:<id>" key prefix; boolean/date fields are stored as their string/numeric representation.',
        `Fields marked non-filterable are stored on the hash but not declared in the search schema (unsearchable): ${fields.filter((f) => f.filterable === false).map((f) => f.name).join(', ') || '(none)'}.`,
      ],
    };
  }

  private generateMongoAtlas(collectionName: string, dimension: number, fields: MetadataFieldDefinition[], metric: SimilarityMetric): JsonConfigSchemaOutput {
    const filterableFields = fields.filter((f) => f.filterable !== false);
    return {
      schema: {
        collectionName,
        name: `${collectionName}_vector_index`,
        type: 'vectorSearch',
        definition: {
          fields: [
            { type: 'vector', path: 'embedding', numDimensions: dimension, similarity: this.metricLiteral('mongodb_atlas', metric) },
            ...filterableFields.map((f) => ({ type: 'filter', path: f.name })),
          ],
        },
      },
      notes: [
        'MongoDB Atlas Vector Search indexes are created via the Atlas API/UI, not a SQL-like DDL statement - this is the search index definition body.',
        'Each filterable metadata field is added as a "filter" field so it can be used in a $vectorSearch pre-filter; this requires MongoDB 7.0+/Atlas Vector Search.',
      ],
    };
  }

  private generateLanceDb(collectionName: string, dimension: number, fields: MetadataFieldDefinition[]): JsonConfigSchemaOutput {
    const lanceTypes: Record<MetadataFieldDefinition['type'], string> = {
      string: 'utf8',
      number: 'float64',
      boolean: 'bool',
      date: 'timestamp[ms]',
      json: 'utf8',
    };
    return {
      schema: {
        table_name: collectionName,
        schema: {
          id: 'utf8',
          embedding: `fixed_size_list<float32>[${dimension}]`,
          ...Object.fromEntries(fields.map((f) => [f.name, lanceTypes[f.type]])),
        },
      },
      notes: [
        'LanceDB is an embedded/serverless library (typically backed by local disk or S3) - there is no server to create a schema against; this Arrow-like schema is passed when the table is created via the client library.',
        'json fields are stored as utf8 (stringified) - LanceDB\'s Arrow schema has no native JSON type.',
      ],
    };
  }

  private generateActian(collectionName: string, dimension: number, fields: MetadataFieldDefinition[]): SqlSchemaOutput {
    const tableName = collectionName;
    const columns = fields.map((f) => `  ${f.name} ${this.sqlColumnType('actian', f.type)}`).join(',\n');
    const ddl = [
      `CREATE TABLE ${tableName} (`,
      `  id VARCHAR(64) NOT NULL PRIMARY KEY,`,
      `  embedding VECTOR(${dimension}) NOT NULL, -- verify exact vector column syntax for your Actian Vector version`,
      columns ? `${columns},` : '',
      `  created_at TIMESTAMP DEFAULT NOW()`,
      `);`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    return {
      ddl,
      notes: [
        'Best-effort ANSI SQL - Actian Vector\'s exact VECTOR column and function syntax varies by version; verify against your target version\'s documentation before applying.',
        'No maintained Node.js driver exists for Actian - live schema execution (Phase 5) requires an ODBC/JDBC bridge configured outside this tool; this DDL is still valid to hand to a DBA or run via isql/another SQL client.',
      ],
    };
  }

  /**
   * Phase 4 requirement: turns the Phase 3 Index Design's decision + tuned
   * parameters into the actual DDL/config that creates the vector index -
   * filling in what the Phase 2 table DDL above left as a commented example.
   */
  generateIndexArtifact(
    platform: VectorPlatform,
    tableName: string,
    indexType: IndexType,
    parameters: IndexTuningParameter[],
    metric: SimilarityMetric = SimilarityMetric.COSINE,
  ): IndexArtifact {
    const sanitizedTable = sanitizeSqlIdentifier(tableName, 'tableName');
    const p = (name: string) => parameters.find((x) => x.name === name)?.value;

    switch (platform) {
      case VectorPlatform.ORACLE:
        return this.generateOracleIndexArtifact(sanitizedTable, indexType, p, metric);
      case VectorPlatform.POSTGRES_PGVECTOR:
        return this.generatePostgresIndexArtifact(sanitizedTable, indexType, p, metric);
      case VectorPlatform.MILVUS:
        return this.generateMilvusIndexArtifact(indexType, p, metric);
      case VectorPlatform.PINECONE:
        return this.generatePineconeIndexArtifact(indexType);
      case VectorPlatform.QDRANT:
        return this.generateQdrantIndexArtifact(indexType, p);
      case VectorPlatform.WEAVIATE:
        return this.generateWeaviateIndexArtifact(indexType, p);
      case VectorPlatform.CHROMA:
        return this.generateChromaIndexArtifact(indexType, p);
      case VectorPlatform.ELASTICSEARCH:
        return this.generateElasticsearchIndexArtifact(sanitizedTable, indexType, p);
      case VectorPlatform.REDIS:
        return this.generateRedisIndexArtifact(sanitizedTable, indexType, p, metric);
      case VectorPlatform.MONGODB_ATLAS:
        return this.generateMongoAtlasIndexArtifact(indexType);
      case VectorPlatform.LANCEDB:
        return this.generateLanceDbIndexArtifact(indexType, p, metric);
      case VectorPlatform.ACTIAN:
        return this.generateActianIndexArtifact(sanitizedTable, indexType, p, metric);
      default:
        throw new BadRequestException(`No index artifact generator is registered for platform '${platform}'.`);
    }
  }

  private generateOracleIndexArtifact(tableName: string, indexType: IndexType, p: (name: string) => number | undefined, metric: SimilarityMetric): IndexArtifact {
    const distance = this.metricLiteral('oracle', metric);
    if (indexType === IndexType.HNSW) {
      return {
        statement: [
          `CREATE VECTOR INDEX ${tableName}_vec_idx ON ${tableName}(embedding)`,
          `  ORGANIZATION INMEMORY NEIGHBOR GRAPH`,
          `  DISTANCE ${distance}`,
          `  PARAMETERS (TYPE HNSW, NEIGHBORS ${p('M')}, EFCONSTRUCTION ${p('efConstruction')});`,
        ].join('\n'),
        notes: [`Set the query-time search width via a hint or session parameter equivalent to efSearch=${p('efSearch')}.`],
      };
    }
    // ivf_flat and pq both map to Oracle's neighbor-partition (IVF) index type - Oracle manages
    // quantization internally and does not expose separate PQ m/nbits knobs.
    return {
      statement: [
        `CREATE VECTOR INDEX ${tableName}_vec_idx ON ${tableName}(embedding)`,
        `  ORGANIZATION NEIGHBOR PARTITIONS`,
        `  DISTANCE ${distance}`,
        `  PARAMETERS (TYPE IVF, NEIGHBOR PARTITIONS ${p('nlist')});`,
      ].join('\n'),
      notes: [
        `At query time, set NEIGHBOR PARTITION PROBES to ${p('nprobe')} (via query hint) for the configured recall/latency trade-off.`,
        indexType === IndexType.PQ
          ? "Oracle does not expose separate PQ 'm'/'nbits' parameters - it manages vector quantization internally for IVF indexes."
          : '',
      ].filter(Boolean),
    };
  }

  private generatePostgresIndexArtifact(tableName: string, indexType: IndexType, p: (name: string) => number | undefined, metric: SimilarityMetric): IndexArtifact {
    const ops = this.metricLiteral('postgres', metric);
    if (indexType === IndexType.HNSW) {
      return {
        statement: `CREATE INDEX IF NOT EXISTS ${tableName}_embedding_hnsw_idx ON ${tableName} USING hnsw (embedding ${ops}) WITH (m = ${p('M')}, ef_construction = ${p('efConstruction')});`,
        notes: [`Set 'SET hnsw.ef_search = ${p('efSearch')};' per session/query for the configured recall/latency trade-off.`],
      };
    }
    // pgvector has no native Product Quantization support - approximate PQ with ivfflat and flag the gap.
    return {
      statement: `CREATE INDEX IF NOT EXISTS ${tableName}_embedding_ivfflat_idx ON ${tableName} USING ivfflat (embedding ${ops}) WITH (lists = ${p('nlist')});`,
      notes: [
        `Set 'SET ivfflat.probes = ${p('nprobe')};' per session/query for the configured recall/latency trade-off.`,
        indexType === IndexType.PQ
          ? 'pgvector has no native Product Quantization index type - substituting ivfflat. Use Milvus if true PQ compression is required.'
          : '',
      ].filter(Boolean),
    };
  }

  private generateMilvusIndexArtifact(indexType: IndexType, p: (name: string) => number | undefined, metric: SimilarityMetric): IndexArtifact {
    const metricType = this.metricLiteral('milvus', metric);
    const byType: Record<IndexType, Record<string, unknown>> = {
      [IndexType.HNSW]: {
        index_type: 'HNSW',
        metric_type: metricType,
        params: { M: p('M'), efConstruction: p('efConstruction') },
      },
      [IndexType.IVF_FLAT]: {
        index_type: 'IVF_FLAT',
        metric_type: metricType,
        params: { nlist: p('nlist') },
      },
      [IndexType.PQ]: {
        index_type: 'IVF_PQ',
        metric_type: metricType,
        params: { nlist: p('nlist'), m: p('m'), nbits: p('nbits') },
      },
    };

    return {
      statement: JSON.stringify({ field_name: 'embedding', ...byType[indexType] }, null, 2),
      notes: [
        `Pass this object to the Milvus SDK's createIndex call, then set search_params.nprobe = ${p('nprobe') ?? 'n/a'} at query time (IVF_FLAT/IVF_PQ) or search_params.ef = ${p('efSearch') ?? 'n/a'} (HNSW).`,
      ],
    };
  }

  private generatePineconeIndexArtifact(indexType: IndexType): IndexArtifact {
    return {
      statement: JSON.stringify({ note: 'Pinecone manages ANN indexing internally; no separate create-index call is needed beyond createSchema.' }, null, 2),
      notes: [
        `The Phase 3 decision (${indexType}) has no user-facing equivalent on Pinecone - it always uses its own internal ANN implementation.`,
        'The closest tunable levers are choosing serverless vs. pod-based deployment and, for pod-based, the pod type/replica count - set at index-creation time, not via a separate index-config call.',
      ],
    };
  }

  private generateQdrantIndexArtifact(indexType: IndexType, p: (name: string) => number | undefined): IndexArtifact {
    if (indexType === IndexType.PQ) {
      return {
        statement: JSON.stringify(
          { hnsw_config: { m: p('M'), ef_construct: p('efConstruction') }, quantization_config: { scalar: { type: 'int8', quantile: 0.99, always_ram: true } } },
          null,
          2,
        ),
        notes: [
          'Qdrant has no separate IVF/PQ index type - this approximates PQ-style compression via scalar (int8) quantization on top of its native HNSW index.',
          `At query time, set search_params.hnsw_ef = ${p('efSearch') ?? 'n/a'} for the configured recall/latency trade-off.`,
        ],
      };
    }
    return {
      statement: JSON.stringify({ hnsw_config: { m: p('M'), ef_construct: p('efConstruction') } }, null, 2),
      notes: [
        indexType === IndexType.IVF_FLAT
          ? 'Qdrant has no separate IVF_FLAT index type - it always uses HNSW; these are the closest equivalent build-time parameters.'
          : '',
        `At query time, set search_params.hnsw_ef = ${p('efSearch') ?? 'n/a'} for the configured recall/latency trade-off.`,
      ].filter(Boolean),
    };
  }

  private generateWeaviateIndexArtifact(indexType: IndexType, p: (name: string) => number | undefined): IndexArtifact {
    if (indexType === IndexType.PQ) {
      return {
        statement: JSON.stringify(
          { vectorIndexConfig: { maxConnections: p('M'), efConstruction: p('efConstruction'), pq: { enabled: true } } },
          null,
          2,
        ),
        notes: ['Weaviate\'s PQ compression is enabled on top of its native HNSW index, not a separate index type.'],
      };
    }
    return {
      statement: JSON.stringify({ vectorIndexConfig: { maxConnections: p('M'), efConstruction: p('efConstruction'), ef: p('efSearch') } }, null, 2),
      notes: [
        indexType === IndexType.IVF_FLAT ? 'Weaviate has no separate IVF_FLAT index type - it always uses HNSW; these are the closest equivalent parameters.' : '',
      ].filter(Boolean),
    };
  }

  private generateChromaIndexArtifact(indexType: IndexType, p: (name: string) => number | undefined): IndexArtifact {
    return {
      statement: JSON.stringify(
        { 'hnsw:construction_ef': p('efConstruction'), 'hnsw:M': p('M'), 'hnsw:search_ef': p('efSearch') },
        null,
        2,
      ),
      notes: [
        indexType !== IndexType.HNSW
          ? `Chroma's underlying hnswlib only supports HNSW - approximating the Phase 3 decision (${indexType}) with tuned HNSW parameters.`
          : '',
        'These are passed as collection metadata at creation time, not a separate createIndex call.',
      ].filter(Boolean),
    };
  }

  private generateElasticsearchIndexArtifact(tableName: string, indexType: IndexType, p: (name: string) => number | undefined): IndexArtifact {
    const indexOptions =
      indexType === IndexType.PQ
        ? { type: 'int8_hnsw', m: p('M'), ef_construction: p('efConstruction') }
        : { type: 'hnsw', m: p('M'), ef_construction: p('efConstruction') };
    return {
      statement: JSON.stringify({ index: tableName, index_options: indexOptions }, null, 2),
      notes: [
        indexType === IndexType.PQ
          ? 'int8_hnsw applies scalar quantization on top of HNSW as the closest available compression to Product Quantization.'
          : indexType === IndexType.IVF_FLAT
            ? 'Elasticsearch has no separate IVF_FLAT index type - it always uses HNSW; these are the closest equivalent parameters.'
            : '',
        `Set num_candidates >= ${p('efSearch') ?? 'n/a'} on each kNN query for the configured recall/latency trade-off.`,
      ].filter(Boolean),
    };
  }

  private generateRedisIndexArtifact(tableName: string, indexType: IndexType, p: (name: string) => number | undefined, metric: SimilarityMetric): IndexArtifact {
    // RediSearch bakes the vector algorithm/params into the field definition at FT.CREATE
    // time (see generateRedis above) - there is no in-place FT.ALTER for an existing vector
    // field's algorithm. Applying a Phase 3 decision made after Phase 2's schema preview
    // means dropping and recreating the index with these algorithm/params substituted into
    // the embedding field of that FT.CREATE command (DIM comes from the Phase 2 schema).
    const distanceMetric = this.metricLiteral('redis', metric);
    const algorithm =
      indexType === IndexType.IVF_FLAT
        ? `FLAT 6 TYPE FLOAT32 DISTANCE_METRIC ${distanceMetric}`
        : `HNSW 8 TYPE FLOAT32 DISTANCE_METRIC ${distanceMetric} M ${p('M')} EF_CONSTRUCTION ${p('efConstruction')}`;
    return {
      statement: `-- Substitute into the embedding field of FT.CREATE ${tableName}_idx (see Phase 2 schema):\nembedding VECTOR ${algorithm}`,
      notes: [
        indexType === IndexType.IVF_FLAT ? 'Redis has no IVF index type - FLAT (brute-force) is the closest built-in alternative, used here as an approximation of IVF_FLAT.' : '',
        indexType === IndexType.PQ ? 'RediSearch has no Product Quantization support - substituting tuned HNSW.' : '',
        'RediSearch has no in-place way to change an existing vector field\'s algorithm/parameters - apply this by dropping (FT.DROPINDEX, keeping documents) and recreating the index with this field definition.',
        `Set EF_RUNTIME ${p('efSearch') ?? 'n/a'} per query for the configured recall/latency trade-off.`,
      ].filter(Boolean),
    };
  }

  private generateMongoAtlasIndexArtifact(indexType: IndexType): IndexArtifact {
    return {
      statement: JSON.stringify({ note: 'Atlas Vector Search indexes are created and tuned via the search index definition in Phase 2 - there is no separate index-build step or exposed HNSW/IVF/PQ parameters.' }, null, 2),
      notes: [`The Phase 3 decision (${indexType}) is not user-tunable on Atlas Vector Search - it manages ANN indexing internally.`],
    };
  }

  private generateLanceDbIndexArtifact(indexType: IndexType, p: (name: string) => number | undefined, metric: SimilarityMetric): IndexArtifact {
    const distance = this.metricLiteral('lancedb', metric);
    if (indexType === IndexType.HNSW) {
      return {
        statement: JSON.stringify({ index_type: 'IVF_HNSW_SQ', metric, m: p('M'), ef_construction: p('efConstruction') }, null, 2),
        notes: [
          'LanceDB\'s HNSW variant is layered over IVF partitioning (IVF_HNSW_SQ) rather than a pure flat-graph HNSW index.',
          `metric maps to LanceDB's distance_type parameter ('${distance}') - verify the exact parameter name against your LanceDB SDK version.`,
        ],
      };
    }
    return {
      statement: JSON.stringify({ index_type: 'IVF_PQ', metric, num_partitions: p('nlist'), num_sub_vectors: p('m') }, null, 2),
      notes: [
        indexType === IndexType.IVF_FLAT ? 'num_sub_vectors is omitted/ignored for a flat (non-quantized) IVF index.' : '',
        `At query time, set nprobes = ${p('nprobe') ?? 'n/a'} for the configured recall/latency trade-off.`,
        `metric maps to LanceDB's distance_type parameter ('${distance}') - verify the exact parameter name against your LanceDB SDK version.`,
      ].filter(Boolean),
    };
  }

  private generateActianIndexArtifact(tableName: string, indexType: IndexType, p: (name: string) => number | undefined, metric: SimilarityMetric): IndexArtifact {
    const distance = this.metricLiteral('actian', metric);
    return {
      statement: [
        `-- Best-effort: verify exact vector index syntax for your Actian Vector version.`,
        `CREATE INDEX ${tableName}_vec_idx ON ${tableName}(embedding)`,
        `  WITH (INDEX_TYPE = '${indexType.toUpperCase()}', DISTANCE = '${distance}', M = ${p('M') ?? 'n/a'}, NLIST = ${p('nlist') ?? 'n/a'});`,
      ].join('\n'),
      notes: ['Actian Vector\'s ANN index syntax and tunable parameters were not independently verified - confirm against your version\'s documentation before applying.'],
    };
  }
}
