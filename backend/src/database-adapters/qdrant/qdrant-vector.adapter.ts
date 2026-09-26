import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
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
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { SimilarityMetric } from '../../discovery/enums/discovery.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerPage, VectorExplorer } from '../vector-explorer';
import { normaliseMetric, qdrantFilter, trimMetadata, vectorFields } from '../explorer-helpers';

/**
 * Connects to the customer's target Qdrant instance (self-hosted on
 * Kubernetes, or Qdrant Cloud). Connection details come only from
 * TARGET_QDRANT_* environment variables.
 */
@Injectable()
export class QdrantVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
  readonly platformId = 'qdrant' as const;
  private readonly logger = new Logger(QdrantVectorAdapter.name);
  private client: QdrantClient | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  private getClient(): QdrantClient {
    if (!this.client) {
      const url = this.config.get<string>('TARGET_QDRANT_URL');
      if (!url) {
        throw new BadRequestException('Qdrant target is not configured. Set TARGET_QDRANT_URL (and TARGET_QDRANT_API_KEY, if required) and retry.');
      }
      this.client = new QdrantClient({ url, apiKey: this.config.get<string>('TARGET_QDRANT_API_KEY') });
    }
    return this.client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getClient().getCollections();
      return true;
    } catch (error) {
      this.logger.error(`Qdrant health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const collection = sanitizeSqlIdentifier(definition.collectionOrTableName, 'collectionOrTableName');
    const { qdrant } = this.schemaGenerator.generateAll({
      collectionName: collection,
      dimension: definition.dimension,
      metric: definition.metric,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    const spec = qdrant.schema as { create_collection_request: { vectors: { size: number; distance: string } }; payload_indexes: Array<{ field_name: string; field_schema: string }> };

    await this.getClient().createCollection(collection, spec.create_collection_request as any);
    for (const index of spec.payload_indexes) {
      await this.getClient().createPayloadIndex(collection, { field_name: index.field_name, field_schema: index.field_schema as any });
    }
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void> {
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.QDRANT, collection, indexType, parameters, metric);
    const config = JSON.parse(artifact.statement) as { hnsw_config?: Record<string, unknown>; quantization_config?: Record<string, unknown> };
    // Qdrant tunes HNSW/quantization via collection update, not a separate index-creation call.
    await this.getClient().updateCollection(collection, config as any);
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    await this.getClient().upsert(collection, {
      points: records.map((r) => ({ id: r.id, vector: r.vector, payload: r.metadata })),
    } as any);
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const params: Record<string, number> = {};
    if (typeof query.searchParams?.efSearch === 'number') params.hnsw_ef = query.searchParams.efSearch;

    const result = await this.getClient().query(collection, {
      query: query.vector,
      limit: query.topK,
      filter: query.filter as any,
      with_payload: true,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    } as any);
    return result.points.map((p: any) => ({ id: String(p.id), score: p.score, metadata: (p.payload as Record<string, unknown>) ?? {} }));
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    await this.getClient().delete(collection, { points: ids } as any);
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop a collection without explicit confirmation (confirm must be true).');
    }
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    this.logger.warn(`Dropping Qdrant collection '${collection}' (confirmed).`);
    await this.getClient().deleteCollection(collection);
  }

  // ------------------------------------------------------ Data Explorer (read-only)

  async listCollections(): Promise<string[]> {
    const r = await this.getClient().getCollections();
    return r.collections.map((c) => c.name).sort();
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const info = (await this.getClient().getCollection(name)) as any;
    const vectors = info.config?.params?.vectors ?? {};
    // One unnamed vector ({ size, distance }) or named vectors ({ name: { size, distance } }): describe the first.
    const named = typeof vectors.size === 'number' ? null : Object.keys(vectors)[0] ?? null;
    const v = named ? vectors[named] : vectors;
    const hnsw = info.config?.hnsw_config ?? {};
    const notes: string[] = [];
    if (named) notes.push(`Named vectors: showing '${named}' of ${Object.keys(vectors).join(', ')}.`);
    const quant = info.config?.quantization_config;
    const quantized = quant && (quant.product || quant.scalar || quant.binary);
    return {
      name,
      recordCount: typeof info.points_count === 'number' ? info.points_count : null,
      countIsEstimate: false,
      dimension: typeof v?.size === 'number' ? v.size : null,
      metric: normaliseMetric(v?.distance ?? null),
      // Qdrant always builds HNSW; product quantization makes it the PQ design.
      indexes: [{ type: quant?.product ? 'pq' : 'hnsw', detail: `HNSW m=${hnsw.m ?? '?'}, ef_construct=${hnsw.ef_construct ?? '?'}${quantized ? `, ${Object.keys(quant).join('/')} quantization` : ''}` }],
      fields: Object.entries(info.payload_schema ?? {}).map(([field, s]: [string, any]) => ({ name: field, type: String(s?.data_type ?? 'unknown') })),
      notes,
    };
  }

  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    let offset: unknown;
    if (options.cursor !== null) {
      try {
        offset = JSON.parse(options.cursor);
      } catch {
        offset = undefined;
      }
      if (typeof offset !== 'number' && typeof offset !== 'string') throw new BadRequestException('Invalid page cursor.');
    }
    const r = (await this.getClient().scroll(name, {
      limit: options.limit,
      ...(offset !== undefined ? { offset } : {}),
      filter: qdrantFilter(options.filter),
      with_payload: true,
      with_vector: true,
    } as any)) as any;
    return {
      records: (r.points ?? []).map((p: any) => {
        const vec = Array.isArray(p.vector) || p.vector === undefined ? p.vector : Object.values(p.vector)[0];
        return { id: String(p.id), metadata: trimMetadata((p.payload as Record<string, unknown>) ?? {}), ...vectorFields(vec, options.withVectors) };
      }),
      // The next point id (number or UUID), kept as JSON so its type survives the round trip.
      nextCursor: r.next_page_offset === null || r.next_page_offset === undefined ? null : JSON.stringify(r.next_page_offset),
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const r = (await this.getClient().query(name, { query: query.vector, limit: query.topK, filter: qdrantFilter(query.filter), with_payload: true } as any)) as any;
    return (r.points ?? []).map((p: any) => ({ id: String(p.id), score: p.score, metadata: trimMetadata((p.payload as Record<string, unknown>) ?? {}) }));
  }
}
