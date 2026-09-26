import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import weaviate, { ApiKey, Filters, WeaviateClient } from 'weaviate-client';
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
import { normaliseIndexType, normaliseMetric, trimMetadata, vectorFields } from '../explorer-helpers';

/**
 * Connects to the customer's target Weaviate instance (self-hosted on
 * Kubernetes, or Weaviate Cloud). Connection details come only from
 * TARGET_WEAVIATE_* environment variables. Weaviate class names must start
 * with an uppercase letter (see SchemaGeneratorService.generateWeaviate) - the
 * same PascalCase conversion is applied here so schema, data, and index calls
 * all agree on the collection's real name.
 */
@Injectable()
export class WeaviateVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
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
      metric: definition.metric,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    // createFromJson accepts the classic REST-style class schema this platform already generates,
    // rather than v3's newer strongly-typed collections.create() config.
    await (await this.getClient()).collections.createFromJson(schemaOutput.schema as any);
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void> {
    // Weaviate's HNSW/PQ parameters are set at class-creation time (see createSchema) and
    // cannot be changed via a separate call without recreating the class - log the intended
    // config for operator visibility rather than silently no-op-ing.
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.WEAVIATE, collectionOrTableName, indexType, parameters, metric);
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

  // ------------------------------------------------------ Data Explorer (read-only)

  /** Weaviate class names are PascalCase (createSchema capitalises the design's name). */
  designedName(designName: string): string {
    return this.className(designName);
  }

  async listCollections(): Promise<string[]> {
    return (await (await this.getClient()).collections.listAll()).map((c) => c.name).sort();
  }

  /** Exact match on each property, ANDed. */
  private filters(collection: any, filter: ExplorerFilter): unknown {
    const parts = Object.entries(filter).map(([name, value]) => collection.filter.byProperty(name).equal(value));
    return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : Filters.and(...parts);
  }

  /** The first (usually only) vector of an object, named or unnamed. */
  private firstVector(o: any): unknown {
    const v = o?.vectors;
    if (!v) return undefined;
    return Array.isArray(v) ? v : Object.values(v)[0];
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const collection = (await this.getClient()).collections.use(name);
    const config = (await collection.config.get()) as any;
    const [vecName, vec] = Object.entries((config.vectorizers ?? {}) as Record<string, { indexType?: string; indexConfig?: { distance?: string } }>)[0] ?? [null, null];
    const total = (await collection.aggregate.overAll()) as any;
    const sample = (await collection.query.fetchObjects({ limit: 1, includeVector: true } as any)) as any;
    const first = this.firstVector(sample.objects?.[0]) as ArrayLike<number> | undefined;
    const notes: string[] = [];
    if (vecName && vecName !== 'default') notes.push(`Named vector '${vecName}' is shown.`);
    return {
      name,
      recordCount: typeof total.totalCount === 'number' ? total.totalCount : null,
      countIsEstimate: false,
      dimension: first ? first.length : null,
      metric: normaliseMetric(vec?.indexConfig?.distance ?? null),
      indexes: vec?.indexType ? [{ type: normaliseIndexType(vec.indexType), detail: `${vec.indexType} (${vec.indexConfig?.distance ?? 'distance not stated'})` }] : [],
      fields: ((config.properties ?? []) as Array<{ name: string; dataType: string }>).map((p) => ({ name: p.name, type: p.dataType })),
      notes,
    };
  }

  /** Weaviate pages by offset (its cursor API cannot be combined with filters); 10,000 deep at most by default. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    const collection = (await this.getClient()).collections.use(name);
    const r = (await collection.query.fetchObjects({ limit: options.limit + 1, offset, filters: this.filters(collection, options.filter), includeVector: true } as any)) as any;
    const objects = (r.objects ?? []) as any[];
    return {
      records: objects.slice(0, options.limit).map((o) => ({ id: String(o.uuid), metadata: trimMetadata((o.properties as Record<string, unknown>) ?? {}), ...vectorFields(this.firstVector(o), options.withVectors) })),
      nextCursor: objects.length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const collection = (await this.getClient()).collections.use(name);
    const r = (await collection.query.nearVector(query.vector, { limit: query.topK, filters: this.filters(collection, query.filter), returnMetadata: ['distance'] } as any)) as any;
    return ((r.objects ?? []) as any[]).map((o) => ({ id: String(o.uuid), score: 1 - (o.metadata?.distance ?? 0), metadata: trimMetadata((o.properties as Record<string, unknown>) ?? {}) }));
  }
}
