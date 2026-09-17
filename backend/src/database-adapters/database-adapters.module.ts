import { Module } from '@nestjs/common';
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
import { VectorAdapterFactory } from './vector-adapter.factory';
import { SchemaGeneratorModule } from '../schema-generator/schema-generator.module';

@Module({
  imports: [SchemaGeneratorModule],
  providers: [
    OracleVectorAdapter,
    PostgresVectorAdapter,
    MilvusVectorAdapter,
    PineconeVectorAdapter,
    QdrantVectorAdapter,
    WeaviateVectorAdapter,
    ChromaVectorAdapter,
    ElasticsearchVectorAdapter,
    RedisVectorAdapter,
    MongoDbAtlasVectorAdapter,
    LanceDbVectorAdapter,
    ActianVectorAdapter,
    VectorAdapterFactory,
  ],
  exports: [VectorAdapterFactory],
})
export class DatabaseAdaptersModule {}
