import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import {
  SchemaDefinition,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { IndexTuningParameter, MetadataFieldDefinition } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/** RediSearch requires vectors as raw little-endian float32 bytes, not a plain array. */
function toVectorBuffer(vector: number[]): Buffer {
  const buf = Buffer.alloc(vector.length * 4);
  vector.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

/**
 * Connects to the customer's target Redis Stack instance (self-hosted on
 * Kubernetes - see Phase 4 notes; standard managed Redis, e.g. AWS
 * ElastiCache, does NOT support vector search). Connection details come only
 * from TARGET_REDIS_* environment variables. Records are stored as Redis
 * Hashes under the "<collection>:<id>" key prefix, matching the FT.CREATE
 * schema generated in Phase 2.
 */
@Injectable()
export class RedisVectorAdapter implements VectorDatabaseAdapter, OnModuleDestroy {
  readonly platformId = 'redis' as const;
  private readonly logger = new Logger(RedisVectorAdapter.name);
  private client: RedisClientType | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }

  private async getClient(): Promise<RedisClientType> {
    if (!this.client) {
      const url = this.config.get<string>('TARGET_REDIS_URL');
      if (!url) {
        throw new BadRequestException('Redis target is not configured. Set TARGET_REDIS_URL and retry.');
      }
      this.client = createClient({ url }) as RedisClientType;
      this.client.on('error', (err) => this.logger.error(`Redis client error: ${err.message}`));
    }
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    return this.client;
  }

  private collectionName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await (await this.getClient()).ping();
      return pong === 'PONG';
    } catch (error) {
      this.logger.error(`Redis health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const collection = this.collectionName(definition.collectionOrTableName);
    const fields: Record<string, any> = {
      id: 'TAG',
      embedding: {
        type: 'VECTOR',
        ALGORITHM: 'HNSW',
        TYPE: 'FLOAT32',
        DIM: definition.dimension,
        DISTANCE_METRIC: 'COSINE',
      },
    };
    const redisTypes: Record<MetadataFieldDefinition['type'], string> = {
      string: 'TAG',
      number: 'NUMERIC',
      boolean: 'TAG',
      date: 'NUMERIC',
      json: 'TEXT',
    };
    for (const f of definition.metadataFields as unknown as MetadataFieldDefinition[]) {
      fields[f.name] = redisTypes[f.type];
    }
    await (await this.getClient()).ft.create(`${collection}_idx`, fields, { ON: 'HASH', PREFIX: `${collection}:` });
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    // RediSearch has no in-place way to change an existing vector field's algorithm/parameters
    // (see SchemaGeneratorService.generateRedisIndexArtifact) - log the intended config so an
    // operator can drop (FT.DROPINDEX, keeping documents) and recreate the index with it.
    this.logger.log(
      `RediSearch requires dropping and recreating the index to apply the Phase 3 decision (${indexType}) for ` +
        `'${collectionOrTableName}' - see the generated index artifact for the exact field definition to use.`,
    );
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = this.collectionName(collectionOrTableName);
    const client = await this.getClient();
    const multi = client.multi();
    for (const record of records) {
      multi.hSet(`${collection}:${record.id}`, {
        id: record.id,
        embedding: toVectorBuffer(record.vector),
        ...(record.metadata as Record<string, string | number>),
      });
    }
    await multi.exec();
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const collection = this.collectionName(collectionOrTableName);
    const client = await this.getClient();
    const efRuntime = query.searchParams?.efSearch;
    const knnClause = efRuntime
      ? `*=>[KNN ${query.topK} @embedding $BLOB EF_RUNTIME ${Math.trunc(efRuntime)} AS score]`
      : `*=>[KNN ${query.topK} @embedding $BLOB AS score]`;
    const result = await client.ft.search(`${collection}_idx`, knnClause, {
      PARAMS: { BLOB: toVectorBuffer(query.vector) },
      SORTBY: { BY: 'score' },
      DIALECT: 2,
    } as any);
    return result.documents.map((doc: any) => {
      const { id, embedding, score, ...metadata } = doc.value;
      return { id: String(doc.id).replace(`${collection}:`, ''), score: 1 - Number(score), metadata };
    });
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = this.collectionName(collectionOrTableName);
    const client = await this.getClient();
    await client.del(ids.map((id) => `${collection}:${id}`));
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop an index without explicit confirmation (confirm must be true).');
    }
    const collection = this.collectionName(collectionOrTableName);
    this.logger.warn(`Dropping RediSearch index '${collection}_idx' and its documents (confirmed).`);
    await (await this.getClient()).ft.dropIndex(`${collection}_idx`, { DD: true } as any);
  }
}
