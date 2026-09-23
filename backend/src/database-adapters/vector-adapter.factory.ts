import { Injectable } from '@nestjs/common';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { VectorDatabaseAdapter } from './vector-database-adapter.interface';
import { OracleVectorAdapter } from './oracle/oracle-vector.adapter';
import { PostgresVectorAdapter } from './postgres/postgres-vector.adapter';
import { MilvusVectorAdapter } from './milvus/milvus-vector.adapter';
import { PineconeVectorAdapter } from './pinecone/pinecone-vector.adapter';
import { QdrantVectorAdapter } from './qdrant/qdrant-vector.adapter';
import { WeaviateVectorAdapter } from './weaviate/weaviate-vector.adapter';
import { ChromaVectorAdapter } from './chroma/chroma-vector.adapter';
import { ElasticsearchVectorAdapter } from './elasticsearch/elasticsearch-vector.adapter';
import { RedisVectorAdapter } from './redis/redis-vector.adapter';
import { MongoDbAtlasVectorAdapter } from './mongodb/mongodb-atlas-vector.adapter';
import { LanceDbVectorAdapter } from './lancedb/lancedb-vector.adapter';
import { ActianVectorAdapter } from './actian/actian-vector.adapter';

/**
 * Single point where a project's resolved platform is mapped to a concrete adapter.
 * Ingestion/Operations engines (Phase 5-7) depend only on this factory, never on a
 * concrete adapter class directly.
 */
@Injectable()
export class VectorAdapterFactory {
  constructor(
    private readonly oracle: OracleVectorAdapter,
    private readonly postgres: PostgresVectorAdapter,
    private readonly milvus: MilvusVectorAdapter,
    private readonly pinecone: PineconeVectorAdapter,
    private readonly qdrant: QdrantVectorAdapter,
    private readonly weaviate: WeaviateVectorAdapter,
    private readonly chroma: ChromaVectorAdapter,
    private readonly elasticsearch: ElasticsearchVectorAdapter,
    private readonly redis: RedisVectorAdapter,
    private readonly mongodbAtlas: MongoDbAtlasVectorAdapter,
    private readonly lancedb: LanceDbVectorAdapter,
    private readonly actian: ActianVectorAdapter,
  ) {}

  getAdapter(platform: VectorPlatform): VectorDatabaseAdapter {
    switch (platform) {
      case VectorPlatform.ORACLE:
        return this.oracle;
      case VectorPlatform.POSTGRES_PGVECTOR:
        return this.postgres;
      case VectorPlatform.MILVUS:
        return this.milvus;
      case VectorPlatform.PINECONE:
        return this.pinecone;
      case VectorPlatform.QDRANT:
        return this.qdrant;
      case VectorPlatform.WEAVIATE:
        return this.weaviate;
      case VectorPlatform.CHROMA:
        return this.chroma;
      case VectorPlatform.ELASTICSEARCH:
        return this.elasticsearch;
      case VectorPlatform.REDIS:
        return this.redis;
      case VectorPlatform.MONGODB_ATLAS:
        return this.mongodbAtlas;
      case VectorPlatform.LANCEDB:
        return this.lancedb;
      case VectorPlatform.ACTIAN:
        return this.actian;
      default:
        throw new Error(
          `Cannot resolve a database adapter: platform is '${platform}'. Complete Phase 4 Vector DB Selection (or manually select a platform) first.`,
        );
    }
  }
}
