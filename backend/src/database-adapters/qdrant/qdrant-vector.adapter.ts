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

/**
 * Connects to the customer's target Qdrant instance (self-hosted on
 * Kubernetes, or Qdrant Cloud). Connection details come only from
 * TARGET_QDRANT_* environment variables.
 */
@Injectable()
export class QdrantVectorAdapter implements VectorDatabaseAdapter {
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
}
