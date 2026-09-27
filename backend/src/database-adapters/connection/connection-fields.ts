/**
 * The connection settings each target platform's adapter reads - the same
 * TARGET_* names as the server environment, so a project profile is simply a
 * per-project replacement for them. `secret` values are never returned.
 */
export interface ConnectionField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  /** Placeholder / hint for the form. */
  hint?: string;
}

const f = (key: string, label: string, opts: Partial<Pick<ConnectionField, 'secret' | 'required' | 'hint'>> = {}): ConnectionField => ({ key, label, secret: false, required: false, ...opts });

export const CONNECTION_FIELDS: Record<string, ConnectionField[]> = {
  postgres_pgvector: [
    f('TARGET_PG_HOST', 'Host', { required: true }),
    f('TARGET_PG_PORT', 'Port', { hint: '5432' }),
    f('TARGET_PG_USER', 'User'),
    f('TARGET_PG_PASSWORD', 'Password', { secret: true }),
    f('TARGET_PG_DATABASE', 'Database'),
    f('TARGET_PG_SSL', 'SSL', { hint: 'true / false' }),
  ],
  oracle: [
    f('TARGET_ORACLE_CONNECT_STRING', 'Connect string', { required: true, hint: 'host:1521/service' }),
    f('TARGET_ORACLE_USER', 'User'),
    f('TARGET_ORACLE_PASSWORD', 'Password', { secret: true }),
  ],
  milvus: [f('TARGET_MILVUS_ADDRESS', 'Address', { required: true, hint: 'host:19530' }), f('TARGET_MILVUS_TOKEN', 'Token', { secret: true }), f('TARGET_MILVUS_SSL', 'SSL', { hint: 'true / false' })],
  qdrant: [f('TARGET_QDRANT_URL', 'URL', { required: true, hint: 'https://host:6333' }), f('TARGET_QDRANT_API_KEY', 'API key', { secret: true })],
  pinecone: [
    f('TARGET_PINECONE_API_KEY', 'API key', { secret: true, required: true }),
    f('TARGET_PINECONE_INDEX', 'Index (for the health check)'),
    f('TARGET_PINECONE_CLOUD', 'Cloud', { hint: 'aws' }),
    f('TARGET_PINECONE_REGION', 'Region', { hint: 'us-east-1' }),
  ],
  weaviate: [
    f('TARGET_WEAVIATE_HTTP_HOST', 'HTTP host', { required: true }),
    f('TARGET_WEAVIATE_HTTP_PORT', 'HTTP port', { hint: '8080' }),
    f('TARGET_WEAVIATE_GRPC_HOST', 'gRPC host'),
    f('TARGET_WEAVIATE_GRPC_PORT', 'gRPC port', { hint: '50051' }),
    f('TARGET_WEAVIATE_SECURE', 'Secure (TLS)', { hint: 'true / false' }),
    f('TARGET_WEAVIATE_API_KEY', 'API key', { secret: true }),
  ],
  chroma: [f('TARGET_CHROMA_HOST', 'Host', { required: true }), f('TARGET_CHROMA_PORT', 'Port', { hint: '8000' }), f('TARGET_CHROMA_SSL', 'SSL', { hint: 'true / false' })],
  elasticsearch: [
    f('TARGET_ELASTICSEARCH_NODE', 'Node URL', { required: true, hint: 'https://host:9200' }),
    f('TARGET_ELASTICSEARCH_API_KEY', 'API key', { secret: true }),
    f('TARGET_ELASTICSEARCH_USERNAME', 'User'),
    f('TARGET_ELASTICSEARCH_PASSWORD', 'Password', { secret: true }),
  ],
  // A Redis URL can carry the password (redis://user:pass@host), so it is secret.
  redis: [f('TARGET_REDIS_URL', 'URL', { secret: true, required: true, hint: 'redis://host:6379' })],
  // So can a MongoDB connection string.
  mongodb_atlas: [f('TARGET_MONGODB_ATLAS_URI', 'Connection string', { secret: true, required: true }), f('TARGET_MONGODB_ATLAS_DATABASE', 'Database', { required: true })],
  lancedb: [f('TARGET_LANCEDB_URI', 'URI', { required: true, hint: 'a folder, or s3:// / gs://' })],
};

export const fieldsFor = (platform: string): ConnectionField[] | null => CONNECTION_FIELDS[platform] ?? null;
