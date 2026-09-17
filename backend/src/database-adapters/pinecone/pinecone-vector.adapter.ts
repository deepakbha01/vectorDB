import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pinecone } from '@pinecone-database/pinecone';
import {
  SchemaDefinition,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { IndexTuningParameter } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/**
 * Connects to the customer's target Pinecone project. Connection details come
 * only from TARGET_PINECONE_* environment variables. Pinecone manages ANN
 * indexing internally (see Phase 3 notes), so `createVectorIndex` is a no-op -
 * the index's dimension/metric are fixed at `createSchema` time.
 *
 * Uses Pinecone SDK v9's classic (dimension/metric/spec) index-creation shape
 * rather than its newer schema/deployment API - this matches the Phase 2
 * generated schema directly and remains fully supported, though marked
 * deprecated in favor of the schema-based API for new hybrid/full-text-search
 * use cases this platform does not need.
 */
@Injectable()
export class PineconeVectorAdapter implements VectorDatabaseAdapter {
  readonly platformId = 'pinecone' as const;
  private readonly logger = new Logger(PineconeVectorAdapter.name);
  private client: Pinecone | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Pinecone {
    if (!this.client) {
      const apiKey = this.config.get<string>('TARGET_PINECONE_API_KEY');
      if (!apiKey) {
        throw new BadRequestException('Pinecone target is not configured. Set TARGET_PINECONE_API_KEY and retry.');
      }
      this.client = new Pinecone({ apiKey });
    }
    return this.client;
  }

  /** Pinecone index names must be lowercase alphanumeric/hyphen - unlike SQL identifiers, underscores are not allowed. */
  private indexName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName').replace(/_/g, '-');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const indexName = this.config.get<string>('TARGET_PINECONE_INDEX');
      if (!indexName) {
        return false;
      }
      await this.getClient().index(indexName).describeIndexStats();
      return true;
    } catch (error) {
      this.logger.error(`Pinecone health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const name = this.indexName(definition.collectionOrTableName);
    const cloud = this.config.get<string>('TARGET_PINECONE_CLOUD', 'aws');
    const region = this.config.get<string>('TARGET_PINECONE_REGION', 'us-east-1');
    await this.getClient().indexes.create({
      name,
      dimension: definition.dimension,
      metric: 'cosine',
      spec: { serverless: { cloud, region } },
      waitUntilReady: true,
    } as Parameters<Pinecone['indexes']['create']>[0]);
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, _parameters: IndexTuningParameter[]): Promise<void> {
    this.logger.log(
      `Pinecone manages ANN indexing internally - the Phase 3 decision (${indexType}) for '${collectionOrTableName}' has no separate ` +
        'index-creation call; dimension/metric were already set in createSchema.',
    );
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const index = this.getClient().index(this.indexName(collectionOrTableName));
    await index.upsert({ records: records.map((r) => ({ id: r.id, values: r.vector, metadata: r.metadata as any })) } as any);
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const index = this.getClient().index(this.indexName(collectionOrTableName));
    const result = await index.query({
      vector: query.vector,
      topK: query.topK,
      includeMetadata: true,
      filter: query.filter as any,
    } as any);
    return (result.matches ?? []).map((m: any) => ({ id: m.id, score: m.score ?? 0, metadata: (m.metadata as Record<string, unknown>) ?? {} }));
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const index = this.getClient().index(this.indexName(collectionOrTableName));
    await index.deleteMany({ ids } as any);
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to delete an index without explicit confirmation (confirm must be true).');
    }
    const name = this.indexName(collectionOrTableName);
    this.logger.warn(`Deleting Pinecone index '${name}' (confirmed).`);
    await this.getClient().indexes.delete(name);
  }
}
