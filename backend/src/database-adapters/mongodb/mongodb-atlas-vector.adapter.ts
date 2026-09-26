import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, Db, MongoClient, ObjectId } from 'mongodb';
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
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerPage, VectorExplorer } from '../vector-explorer';
import { fieldsFromSample, mongoFilter, normaliseMetric, trimMetadata, vectorFields } from '../explorer-helpers';

/** A document id in a page cursor, keeping ObjectId and string ids apart. */
type IdCursor = { t: 'o' | 's'; v: string };

/**
 * Connects to the customer's target MongoDB Atlas cluster. Connection
 * details come only from TARGET_MONGODB_ATLAS_* environment variables. Atlas
 * Vector Search indexes are managed asynchronously by Atlas after creation
 * (they take time to build) - `createVectorIndex` submits the request but
 * does not itself wait for the index to become queryable.
 */
@Injectable()
export class MongoDbAtlasVectorAdapter implements VectorDatabaseAdapter, VectorExplorer, OnModuleDestroy {
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

  // ------------------------------------------------------ Data Explorer (read-only)

  /** The collection's Atlas Vector Search index definition, or null (not Atlas, or no vector index). */
  private async vectorIndex(name: string): Promise<{ name: string; vector: any; filters: string[] } | null> {
    try {
      const indexes = (await (await this.getDb()).collection(name).listSearchIndexes().toArray()) as any[];
      const idx = indexes.find((i) => i.type === 'vectorSearch');
      if (!idx) return null;
      const fields = (idx.latestDefinition?.fields ?? idx.definition?.fields ?? []) as any[];
      return { name: idx.name, vector: fields.find((f) => f.type === 'vector') ?? null, filters: fields.filter((f) => f.type === 'filter').map((f) => f.path) };
    } catch {
      return null;
    }
  }

  /** Collections with an Atlas Vector Search index (the first 100 collections are checked). */
  async listCollections(): Promise<string[]> {
    const db = await this.getDb();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).slice(0, 100);
    const withIndex = await Promise.all(names.map(async (n) => ((await this.vectorIndex(n)) ? n : null)));
    return withIndex.filter((n): n is string => !!n).sort();
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const collection = (await this.getDb()).collection(name);
    const idx = await this.vectorIndex(name);
    const path = idx?.vector?.path ?? 'embedding';
    const sample = await collection.find({}, { projection: { [path]: 0 } }).limit(20).toArray();
    const notes = ['MongoDB has no fixed schema: fields are those seen in the first 20 documents.'];
    if (idx?.filters.length) notes.push(`Search can filter only on the index's filter fields: ${idx.filters.join(', ')}.`);
    else notes.push('The vector index declares no filter fields, so search cannot be filtered.');
    return {
      name,
      recordCount: await collection.estimatedDocumentCount(),
      countIsEstimate: true,
      dimension: typeof idx?.vector?.numDimensions === 'number' ? idx.vector.numDimensions : null,
      metric: normaliseMetric(idx?.vector?.similarity ?? null),
      // Atlas Vector Search indexes are HNSW graphs; Atlas chooses their parameters.
      indexes: idx ? [{ type: 'hnsw', detail: `Atlas Vector Search index '${idx.name}' on ${path} (HNSW, managed by Atlas)` }] : [],
      fields: fieldsFromSample(sample as Array<Record<string, unknown>>, ['_id', path]),
      notes,
    };
  }

  private encodeCursor(id: unknown): string {
    const c: IdCursor = id instanceof ObjectId ? { t: 'o', v: id.toHexString() } : { t: 's', v: String(id) };
    return JSON.stringify(c);
  }

  private decodeCursor(cursor: string): unknown {
    try {
      const c = JSON.parse(cursor) as IdCursor;
      if (c.t === 'o' && ObjectId.isValid(c.v)) return new ObjectId(c.v);
      if (c.t === 's' && typeof c.v === 'string') return c.v;
    } catch {
      // fall through
    }
    throw new BadRequestException('Invalid page cursor.');
  }

  /** Pages in _id order, continuing after the last id seen. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const collection = (await this.getDb()).collection(name);
    const path = (await this.vectorIndex(name))?.vector?.path ?? 'embedding';
    const query: Record<string, unknown> = { ...mongoFilter(options.filter) };
    if (options.cursor !== null) query._id = { $gt: this.decodeCursor(options.cursor) };
    const docs = await collection.find(query as any).sort({ _id: 1 }).limit(options.limit + 1).toArray();
    const page = docs.slice(0, options.limit);
    return {
      records: page.map((d: any) => {
        const { _id, [path]: vec, ...metadata } = d;
        return { id: String(_id), metadata: trimMetadata(metadata), ...vectorFields(vec, options.withVectors) };
      }),
      nextCursor: docs.length > options.limit ? this.encodeCursor(page[page.length - 1]._id) : null,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const collection = (await this.getDb()).collection(name);
    const idx = await this.vectorIndex(name);
    if (!idx) throw new BadRequestException(`Collection '${name}' has no Atlas Vector Search index.`);
    const path = idx.vector?.path ?? 'embedding';
    const f = mongoFilter(query.filter);
    const unindexed = Object.keys(f).filter((k) => !idx.filters.includes(k));
    if (unindexed.length) throw new BadRequestException(`Atlas can only filter a vector search on the index's filter fields (${idx.filters.join(', ') || 'none'}); not on ${unindexed.join(', ')}.`);
    const results = await collection
      .aggregate([
        { $vectorSearch: { index: idx.name, path, queryVector: query.vector, numCandidates: Math.max(query.topK * 10, 100), limit: query.topK, ...(Object.keys(f).length ? { filter: f } : {}) } },
        { $project: { [path]: 0, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();
    return results.map((r: any) => {
      const { _id, score, ...metadata } = r;
      return { id: String(_id), score: score ?? 0, metadata: trimMetadata(metadata) };
    });
  }
}
