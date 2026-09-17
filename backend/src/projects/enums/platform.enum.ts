/**
 * A project's target platform is UNDETERMINED until the Phase 1 Discovery
 * assessment runs and the Recommendation Engine produces an Architecture
 * Decision Record (Sprint 2). A user may also force an override.
 */
export enum VectorPlatform {
  UNDETERMINED = 'undetermined',
  ORACLE = 'oracle',
  POSTGRES_PGVECTOR = 'postgres_pgvector',
  MILVUS = 'milvus',
  PINECONE = 'pinecone',
  QDRANT = 'qdrant',
  WEAVIATE = 'weaviate',
  CHROMA = 'chroma',
  ELASTICSEARCH = 'elasticsearch',
  REDIS = 'redis',
  MONGODB_ATLAS = 'mongodb_atlas',
  LANCEDB = 'lancedb',
  ACTIAN = 'actian',
}

/** Every platform is scored/recommendable by Phase 1 and has full Phase 2/3/4/7 config-generation support. */
export const IMPLEMENTED_BEYOND_DISCOVERY: ReadonlySet<VectorPlatform> = new Set([
  VectorPlatform.ORACLE,
  VectorPlatform.POSTGRES_PGVECTOR,
  VectorPlatform.MILVUS,
  VectorPlatform.PINECONE,
  VectorPlatform.QDRANT,
  VectorPlatform.WEAVIATE,
  VectorPlatform.CHROMA,
  VectorPlatform.ELASTICSEARCH,
  VectorPlatform.REDIS,
  VectorPlatform.MONGODB_ATLAS,
  VectorPlatform.LANCEDB,
  VectorPlatform.ACTIAN,
]);

/**
 * No maintained Node.js driver exists for Actian - every other platform below
 * can be live-connected to by its Phase 5 adapter (credentials/network
 * permitting); Actian's adapter documents this gap rather than connecting.
 * Used only for Phase 5 (ingestion) messaging - Actian's Phase 2/3/4/7
 * config/text generation works the same as every other platform.
 */
export const LIVE_INGESTION_SUPPORTED: ReadonlySet<VectorPlatform> = new Set(
  [...IMPLEMENTED_BEYOND_DISCOVERY].filter((p) => p !== VectorPlatform.ACTIAN),
);

/**
 * "Bolt vector search onto an existing general-purpose engine" - SQL-based,
 * favors small-to-medium scale (you're not standing up new infra), and has a
 * lower latency/recall ceiling than a purpose-built ANN engine.
 */
export const SQL_BASED_PLATFORMS = [VectorPlatform.ORACLE, VectorPlatform.POSTGRES_PGVECTOR, VectorPlatform.ACTIAN];

/**
 * Embedded/local vector libraries - same small-to-medium scale profile as
 * SQL_BASED_PLATFORMS (not built for distributed/sharded scale), but with a
 * mature ANN engine under the hood, so they share the higher latency/recall
 * ceiling with the dedicated/managed platforms below. No server to deploy -
 * infra generation targets object storage/a lightweight container instead of
 * a database instance or cluster.
 */
export const EMBEDDED_LIBRARY_PLATFORMS = [VectorPlatform.CHROMA, VectorPlatform.LANCEDB];

/**
 * Purpose-built dedicated/managed vector engines - scale up well, so a small
 * workload is scored as "overkill" for these; higher latency/recall ceiling.
 */
export const DEDICATED_AT_SCALE_PLATFORMS = [
  VectorPlatform.MILVUS,
  VectorPlatform.PINECONE,
  VectorPlatform.QDRANT,
  VectorPlatform.WEAVIATE,
  VectorPlatform.ELASTICSEARCH,
  VectorPlatform.REDIS,
  VectorPlatform.MONGODB_ATLAS,
];

/** Self-hostable on Kubernetes (unlike Pinecone/MongoDB Atlas, which are SaaS-only) - infra generation targets a K8s cluster + Helm chart. */
export const K8S_SELF_HOSTABLE_PLATFORMS = [
  VectorPlatform.MILVUS,
  VectorPlatform.QDRANT,
  VectorPlatform.WEAVIATE,
  VectorPlatform.ELASTICSEARCH,
  VectorPlatform.REDIS,
];

/** Fully managed SaaS - no self-host option at all; infra generation targets the vendor's own Terraform provider, never Kubernetes. */
export const FULLY_MANAGED_SAAS_PLATFORMS = [VectorPlatform.PINECONE, VectorPlatform.MONGODB_ATLAS];
