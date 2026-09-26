import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType, RESP_TYPES } from 'redis';
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
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerPage, VectorExplorer } from '../vector-explorer';
import { normaliseIndexType, normaliseMetric, redisFilter, trimMetadata, vectorFields } from '../explorer-helpers';

/** Little-endian float32 bytes back to numbers. */
function fromVectorBuffer(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

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
export class RedisVectorAdapter implements VectorDatabaseAdapter, VectorExplorer, OnModuleDestroy {
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

  // ------------------------------------------------------ Data Explorer (read-only)

  /** Collections are RediSearch indexes named `<collection>_idx` over hashes `<collection>:<id>` (createSchema's layout). */
  async listCollections(): Promise<string[]> {
    const names = (await (await this.getClient()).ft._list()) as unknown as string[];
    return names.filter((n) => String(n).endsWith('_idx')).map((n) => String(n).slice(0, -4)).sort();
  }

  /** FT.INFO attributes, with keys lower-cased (their case differs between server versions). */
  private async attributes(name: string): Promise<{ info: any; attrs: Array<Record<string, any>> }> {
    const info = (await (await this.getClient()).ft.info(`${name}_idx`)) as any;
    const attrs = ((info.attributes ?? []) as any[]).map((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k.toLowerCase(), v])));
    return { info, attrs };
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const { info, attrs } = await this.attributes(name);
    const vector = attrs.find((a) => String(a.type).toUpperCase() === 'VECTOR');
    const algorithm = vector?.algorithm ? String(vector.algorithm) : null;
    return {
      name,
      recordCount: info.num_docs !== undefined ? Number(info.num_docs) : null,
      countIsEstimate: false,
      dimension: vector?.dim !== undefined ? Number(vector.dim) : null,
      metric: normaliseMetric(vector?.distance_metric ? String(vector.distance_metric) : null),
      indexes: algorithm ? [{ type: normaliseIndexType(algorithm), detail: `${algorithm} (${vector?.data_type ?? vector?.type ?? 'vector'})` }] : [],
      fields: attrs.filter((a) => a !== vector && String(a.attribute ?? a.identifier) !== 'id').map((a) => ({ name: String(a.attribute ?? a.identifier), type: String(a.type) })),
      notes: [],
    };
  }

  /** Vectors are stored as bytes; read them back as buffers, one hash field per record. */
  private async vectorOf(key: string): Promise<number[] | undefined> {
    const client = (await this.getClient()).withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
    const buf = (await client.hGet(key, 'embedding')) as unknown as Buffer | null;
    return buf ? fromVectorBuffer(buf) : undefined;
  }

  /** RediSearch pages by offset (LIMIT from size). */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    const { attrs } = await this.attributes(name);
    const fields = attrs.filter((a) => String(a.type).toUpperCase() !== 'VECTOR').map((a) => ({ name: String(a.attribute ?? a.identifier), type: String(a.type) }));
    const q = redisFilter(options.filter, fields) || '*';
    const r = (await (await this.getClient()).ft.search(`${name}_idx`, q, { LIMIT: { from: offset, size: options.limit + 1 }, RETURN: fields.map((f) => f.name), DIALECT: 2 } as any)) as any;
    const docs = ((r.documents ?? []) as any[]).slice(0, options.limit);
    const records = [];
    for (const d of docs) {
      const { id: _id, ...metadata } = d.value ?? {};
      records.push({ id: String(d.id).replace(`${name}:`, ''), metadata: trimMetadata(metadata), ...vectorFields(await this.vectorOf(String(d.id)), options.withVectors) });
    }
    return { records, nextCursor: (r.documents ?? []).length > options.limit ? String(offset + options.limit) : null };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const info = await this.describeCollection(name);
    const pre = redisFilter(query.filter, info.fields);
    const r = (await (await this.getClient()).ft.search(`${name}_idx`, `${pre ? `(${pre})` : '*'}=>[KNN ${Math.trunc(query.topK)} @embedding $BLOB AS score]`, {
      PARAMS: { BLOB: toVectorBuffer(query.vector) },
      SORTBY: { BY: 'score' },
      RETURN: [...info.fields.map((f) => f.name), 'score'],
      DIALECT: 2,
    } as any)) as any;
    return ((r.documents ?? []) as any[]).map((d) => {
      const { id: _id, embedding: _e, score, ...metadata } = d.value ?? {};
      return { id: String(d.id).replace(`${name}:`, ''), score: 1 - Number(score), metadata: trimMetadata(metadata) };
    });
  }
}
