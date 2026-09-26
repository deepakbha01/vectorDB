import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChromaClient, Collection } from 'chromadb';
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
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerPage, VectorExplorer } from '../vector-explorer';
import { chromaWhere, fieldsFromSample, normaliseMetric, trimMetadata, vectorFields } from '../explorer-helpers';

/**
 * Connects to a self-hosted Chroma server (typically a single lightweight
 * container - see Phase 4). Connection details come only from
 * TARGET_CHROMA_* environment variables. `embeddingFunction: null` is passed
 * everywhere a collection is opened, since this platform always supplies its
 * own pre-computed embeddings rather than asking Chroma to embed text.
 */
@Injectable()
export class ChromaVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
  readonly platformId = 'chroma' as const;
  private readonly logger = new Logger(ChromaVectorAdapter.name);
  private client: ChromaClient | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): ChromaClient {
    if (!this.client) {
      const host = this.config.get<string>('TARGET_CHROMA_HOST');
      if (!host) {
        throw new BadRequestException('Chroma target is not configured. Set TARGET_CHROMA_HOST and retry.');
      }
      this.client = new ChromaClient({
        host,
        port: this.config.get<number>('TARGET_CHROMA_PORT', 8000),
        ssl: this.config.get<string>('TARGET_CHROMA_SSL') === 'true',
      });
    }
    return this.client;
  }

  private collectionName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
  }

  private async getCollection(collectionOrTableName: string): Promise<Collection> {
    return this.getClient().getCollection({ name: this.collectionName(collectionOrTableName), embeddingFunction: null as any });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getClient().heartbeat();
      return true;
    } catch (error) {
      this.logger.error(`Chroma health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    await this.getClient().createCollection({
      name: this.collectionName(definition.collectionOrTableName),
      embeddingFunction: null,
      metadata: { 'hnsw:space': 'cosine' },
    });
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    const p = (name: string) => parameters.find((x) => x.name === name)?.value;
    const collection = await this.getCollection(collectionOrTableName);
    // Chroma's HNSW parameters are collection metadata, updated via modify() rather than a
    // separate index-creation call; there is no native IVF/PQ, so all Phase 3 decisions map to HNSW.
    await collection.modify({
      configuration: { hnsw: { ef_construction: p('efConstruction'), max_neighbors: p('M'), ef_search: p('efSearch') } } as any,
    });
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = await this.getCollection(collectionOrTableName);
    await collection.upsert({
      ids: records.map((r) => r.id),
      embeddings: records.map((r) => r.vector),
      metadatas: records.map((r) => r.metadata as any),
    });
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const collection = await this.getCollection(collectionOrTableName);
    const result = await collection.query({
      queryEmbeddings: [query.vector],
      nResults: query.topK,
      where: query.filter as any,
      include: ['metadatas' as any, 'distances' as any],
    });
    const ids = result.ids[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    return ids.map((id, i) => ({ id, score: 1 - (distances[i] ?? 0), metadata: (metadatas[i] as Record<string, unknown>) ?? {} }));
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = await this.getCollection(collectionOrTableName);
    await collection.delete({ ids });
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to delete a collection without explicit confirmation (confirm must be true).');
    }
    const name = this.collectionName(collectionOrTableName);
    this.logger.warn(`Deleting Chroma collection '${name}' (confirmed).`);
    await this.getClient().deleteCollection({ name });
  }

  // ------------------------------------------------------ Data Explorer (read-only)

  /** Opened by its listed name exactly (no sanitising), never with an embedding function. */
  private open(name: string): Promise<Collection> {
    return this.getClient().getCollection({ name, embeddingFunction: null as any });
  }

  async listCollections(): Promise<string[]> {
    return (await this.getClient().listCollections({ limit: 1000 })).map((c) => c.name).sort();
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const c = await this.open(name);
    const sample = await c.get({ limit: 20, include: ['embeddings' as any, 'metadatas' as any] });
    const cfg = (c as any).configuration ?? {};
    const space = (c.metadata as Record<string, unknown> | undefined)?.['hnsw:space'] ?? cfg.hnsw?.space ?? null;
    const notes: string[] = ['Chroma has no fixed schema: fields are those seen in the first 20 records.'];
    if (!space) notes.push("The collection sets no distance; Chroma's default is L2.");
    const first = sample.embeddings?.[0] as unknown;
    return {
      name,
      recordCount: await c.count(),
      countIsEstimate: false,
      dimension: Array.isArray(first) || ArrayBuffer.isView(first) ? (first as ArrayLike<number>).length : null,
      metric: normaliseMetric(typeof space === 'string' ? space : 'l2'),
      indexes: [{ type: 'hnsw', detail: `Chroma HNSW${cfg.hnsw ? ` ${JSON.stringify(cfg.hnsw)}` : ''}` }],
      fields: fieldsFromSample((sample.metadatas ?? []) as Array<Record<string, unknown>>),
      notes,
    };
  }

  /** Chroma pages by offset. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    const c = await this.open(name);
    const r = await c.get({ limit: options.limit + 1, offset, where: chromaWhere(options.filter) as any, include: ['embeddings' as any, 'metadatas' as any] });
    const ids = r.ids.slice(0, options.limit);
    return {
      records: ids.map((id, i) => ({ id: String(id), metadata: trimMetadata((r.metadatas?.[i] as Record<string, unknown>) ?? {}), ...vectorFields(r.embeddings?.[i], options.withVectors) })),
      nextCursor: r.ids.length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const c = await this.open(name);
    const r = await c.query({ queryEmbeddings: [query.vector], nResults: query.topK, where: chromaWhere(query.filter) as any, include: ['metadatas' as any, 'distances' as any] });
    const ids = r.ids[0] ?? [];
    return ids.map((id, i) => ({ id: String(id), score: 1 - Number(r.distances?.[0]?.[i] ?? 0), metadata: trimMetadata((r.metadatas?.[0]?.[i] as Record<string, unknown>) ?? {}) }));
  }
}
