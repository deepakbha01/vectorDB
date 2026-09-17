import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import weaviate, { ApiKey, WeaviateClient } from 'weaviate-client';
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
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/**
 * Connects to the customer's target Weaviate instance (self-hosted on
 * Kubernetes, or Weaviate Cloud). Connection details come only from
 * TARGET_WEAVIATE_* environment variables. Weaviate class names must start
 * with an uppercase letter (see SchemaGeneratorService.generateWeaviate) - the
 * same PascalCase conversion is applied here so schema, data, and index calls
 * all agree on the collection's real name.
 */
@Injectable()
export class WeaviateVectorAdapter implements VectorDatabaseAdapter {
  readonly platformId = 'weaviate' as const;
  private readonly logger = new Logger(WeaviateVectorAdapter.name);
  private client: WeaviateClient | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  private className(collectionOrTableName: string): string {
    const sanitized = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
  }

  private async getClient(): Promise<WeaviateClient> {
    if (!this.client) {
      const host = this.config.get<string>('TARGET_WEAVIATE_HTTP_HOST');
      if (!host) {
        throw new BadRequestException('Weaviate target is not configured. Set TARGET_WEAVIATE_HTTP_HOST (and _GRPC_HOST/_API_KEY, if required) and retry.');
      }
      const apiKey = this.config.get<string>('TARGET_WEAVIATE_API_KEY');
      this.client = await weaviate.connectToCustom({
        httpHost: host,
        httpPort: this.config.get<number>('TARGET_WEAVIATE_HTTP_PORT', 8080),
        grpcHost: this.config.get<string>('TARGET_WEAVIATE_GRPC_HOST', host),
        grpcPort: this.config.get<number>('TARGET_WEAVIATE_GRPC_PORT', 50051),
        httpSecure: this.config.get<string>('TARGET_WEAVIATE_SECURE') === 'true',
        grpcSecure: this.config.get<string>('TARGET_WEAVIATE_SECURE') === 'true',
        authCredentials: apiKey ? new ApiKey(apiKey) : undefined,
      });
    }
    return this.client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await (await this.getClient()).isReady();
    } catch (error) {
      this.logger.error(`Weaviate health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const { weaviate: schemaOutput } = this.schemaGenerator.generateAll({
      collectionName: definition.collectionOrTableName,
      dimension: definition.dimension,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    // createFromJson accepts the classic REST-style class schema this platform already generates,
    // rather than v3's newer strongly-typed collections.create() config.
    await (await this.getClient()).collections.createFromJson(schemaOutput.schema as any);
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    // Weaviate's HNSW/PQ parameters are set at class-creation time (see createSchema) and
    // cannot be changed via a separate call without recreating the class - log the intended
    // config for operator visibility rather than silently no-op-ing.
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.WEAVIATE, collectionOrTableName, indexType, parameters);
    this.logger.log(
      `Weaviate's vectorIndexConfig for '${collectionOrTableName}' must be set when the class is created; recreate the class with ` +
        `this configuration to apply Phase 3's ${indexType} decision: ${artifact.statement}`,
    );
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = (await this.getClient()).collections.use(this.className(collectionOrTableName));
    await collection.data.insertMany(records.map((r) => ({ id: r.id, properties: r.metadata, vectors: r.vector })) as any);
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const collection = (await this.getClient()).collections.use(this.className(collectionOrTableName));
    const result = await collection.query.nearVector(query.vector, {
      limit: query.topK,
      returnMetadata: ['distance'],
      filters: query.filter as any,
    } as any);
    return (result.objects as any[]).map((o) => ({
      id: String(o.uuid),
      score: 1 - (o.metadata?.distance ?? 0),
      metadata: o.properties as Record<string, unknown>,
    }));
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = (await this.getClient()).collections.use(this.className(collectionOrTableName));
    for (const id of ids) {
      await collection.data.deleteById(id);
    }
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to delete a class without explicit confirmation (confirm must be true).');
    }
    const className = this.className(collectionOrTableName);
    this.logger.warn(`Deleting Weaviate class '${className}' (confirmed).`);
    await (await this.getClient()).collections.delete(className);
  }
}
