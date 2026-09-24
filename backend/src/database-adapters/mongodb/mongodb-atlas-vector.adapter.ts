import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, Db, MongoClient } from 'mongodb';
import {
  SchemaDefinition,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexTuningParameter } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/**
 * Connects to the customer's target MongoDB Atlas cluster. Connection
 * details come only from TARGET_MONGODB_ATLAS_* environment variables. Atlas
 * Vector Search indexes are managed asynchronously by Atlas after creation
 * (they take time to build) - `createVectorIndex` submits the request but
 * does not itself wait for the index to become queryable.
 */
@Injectable()
export class MongoDbAtlasVectorAdapter implements VectorDatabaseAdapter, OnModuleDestroy {
  readonly platformId = 'mongodb_atlas' as const;
  private readonly logger = new Logger(MongoDbAtlasVectorAdapter.name);
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  private async getDb(): Promise<Db> {
    if (!this.db) {
      const uri = this.config.get<string>('TARGET_MONGODB_ATLAS_URI');
      const databaseName = this.config.get<string>('TARGET_MONGODB_ATLAS_DATABASE');
      if (!uri || !databaseName) {
        throw new BadRequestException('MongoDB Atlas target is not configured. Set TARGET_MONGODB_ATLAS_URI and TARGET_MONGODB_ATLAS_DATABASE and retry.');
      }
      this.client = new MongoClient(uri);
      await this.client.connect();
      this.db = this.client.db(databaseName);
    }
    return this.db;
  }

  private collectionName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
  }

  private async getCollection(collectionOrTableName: string): Promise<Collection> {
    return (await this.getDb()).collection(this.collectionName(collectionOrTableName));
  }

  async healthCheck(): Promise<boolean> {
    try {
      await (await this.getDb()).command({ ping: 1 });
      return true;
    } catch (error) {
      this.logger.error(`MongoDB Atlas health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const collectionName = this.collectionName(definition.collectionOrTableName);
    const db = await this.getDb();
    await db.createCollection(collectionName);
    const { mongodb_atlas } = this.schemaGenerator.generateAll({
      collectionName,
      dimension: definition.dimension,
      metric: definition.metric,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    const spec = mongodb_atlas.schema as { name: string; type: string; definition: Record<string, unknown> };
    await db.collection(collectionName).createSearchIndex({ name: spec.name, type: 'vectorSearch', definition: spec.definition });
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, _parameters: IndexTuningParameter[]): Promise<void> {
    this.logger.log(
      `Atlas Vector Search manages ANN indexing internally - the Phase 3 decision (${indexType}) for '${collectionOrTableName}' has ` +
        'no separate index-creation call or exposed HNSW/IVF/PQ parameters; the search index definition was already submitted in createSchema.',
    );
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = await this.getCollection(collectionOrTableName);
    const operations = records.map((r) => ({
      updateOne: {
        filter: { _id: r.id as any },
        update: { $set: { _id: r.id, embedding: r.vector, ...r.metadata } },
        upsert: true,
      },
    }));
    await collection.bulkWrite(operations as any);
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const collection = await this.getCollection(collectionOrTableName);
    const indexName = `${this.collectionName(collectionOrTableName)}_vector_index`;
    const numCandidates = query.searchParams?.efSearch ?? Math.max(query.topK * 10, 100);
    const results = await collection
      .aggregate([
        {
          $vectorSearch: {
            index: indexName,
            path: 'embedding',
            queryVector: query.vector,
            numCandidates,
            limit: query.topK,
            filter: query.filter as any,
          },
        },
        { $project: { embedding: 0, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();
    return results.map((r: any) => {
      const { _id, score, ...metadata } = r;
      return { id: String(_id), score: score ?? 0, metadata };
    });
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = await this.getCollection(collectionOrTableName);
    await collection.deleteMany({ _id: { $in: ids as any[] } });
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop a collection without explicit confirmation (confirm must be true).');
    }
    const collectionName = this.collectionName(collectionOrTableName);
    this.logger.warn(`Dropping MongoDB Atlas collection '${collectionName}' (confirmed).`);
    await (await this.getDb()).collection(collectionName).drop();
  }
}
