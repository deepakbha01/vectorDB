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

/**
 * Connects to a self-hosted Chroma server (typically a single lightweight
 * container - see Phase 4). Connection details come only from
 * TARGET_CHROMA_* environment variables. `embeddingFunction: null` is passed
 * everywhere a collection is opened, since this platform always supplies its
 * own pre-computed embeddings rather than asking Chroma to embed text.
 */
@Injectable()
export class ChromaVectorAdapter implements VectorDatabaseAdapter {
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
}
