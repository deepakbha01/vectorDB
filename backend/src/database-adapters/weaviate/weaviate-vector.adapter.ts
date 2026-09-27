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
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerKeywordQuery, ExplorerNativeHybridQuery, ExplorerPage, ExplorerPartitions, ExplorerRecordDetail, ExplorerVectorQuery, MAX_PARTITIONS, RecordReadOptions, VectorExplorer } from '../vector-explorer';
import { normaliseIndexType, normaliseMetric, pickVector, recordDetail, trimMetadata, vectorFields } from '../explorer-helpers';

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

  /** Each condition on a property; all of them (Filters.and) or any (Filters.or). */
  private filters(collection: any, filter: ExplorerFilter): unknown {
    const METHOD = { eq: 'equal', ne: 'notEqual', gt: 'greaterThan', gte: 'greaterOrEqual', lt: 'lessThan', lte: 'lessOrEqual', in: 'containsAny' } as const;
    const parts = filter.conditions.map((c) => {
      const p = collection.filter.byProperty(c.field);
      return p[METHOD[c.op]](c.op === 'in' ? (Array.isArray(c.value) ? c.value : [c.value]) : c.value);
    });
    return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : filter.combine === 'or' ? Filters.or(...parts) : Filters.and(...parts);
  }

  /** An object's vector: the named one asked for, else the first (usually only). */
  private firstVector(o: any, vectorName?: string): unknown {
    return pickVector(o?.vectors, vectorName);
  }

  /**
   * The vector to use: the one asked for, else - where the collection has
   * named vectors - its first, the vector describeCollection reports.
   * Weaviate needs targetVector spelled out when a collection has several.
   */
  private async vectorFor(name: string, requested?: string): Promise<string | undefined> {
    if (requested) return requested;
    const config = (await (await this.getClient()).collections.use(name).config.get()) as any;
    const names = Object.keys(config?.vectorizers ?? {});
    return names.length > 1 || (names[0] && names[0] !== 'default') ? names[0] : undefined;
  }

  /**
   * The collection handle, for one tenant where the collection is
   * multi-tenant (every read there must name a tenant).
   */
  private async handle(name: string, partition?: string): Promise<any> {
    const collection = (await this.getClient()).collections.use(name) as any;
    return partition ? collection.withTenant(partition) : collection;
  }

  /** Tenants of a multi-tenant collection, or null when it is not one. */
  private async tenantsOf(name: string, config: any): Promise<ExplorerPartitions | null> {
    if (!config?.multiTenancy?.enabled) return null;
    const all = Object.values(((await ((await this.getClient()).collections.use(name) as any).tenants.get()) ?? {}) as Record<string, { name: string }>).map((t) => t.name).sort();
    return { kind: 'tenant', names: all.slice(0, MAX_PARTITIONS), required: true, ...(all.length > MAX_PARTITIONS ? { truncated: true } : {}) };
  }

  async describeCollection(name: string, partition?: string): Promise<ExplorerCollectionInfo> {
    const base = (await this.getClient()).collections.use(name);
    const config = (await base.config.get()) as any;
    const tenants = await this.tenantsOf(name, config);
    // A multi-tenant collection is counted and sampled one tenant at a time.
    const tenant = tenants ? (partition ?? tenants.names[0]) : undefined;
    const collection = await this.handle(name, tenant);
    const spaces = Object.entries((config.vectorizers ?? {}) as Record<string, { indexType?: string; indexConfig?: { distance?: string } }>);
    const [vecName, vec] = spaces[0] ?? [null, null];
    const total = tenant || !tenants ? ((await collection.aggregate.overAll()) as any) : {};
    const sample = tenant || !tenants ? ((await collection.query.fetchObjects({ limit: 1, includeVector: true } as any)) as any) : {};
    const first = this.firstVector(sample.objects?.[0], vecName ?? undefined) as ArrayLike<number> | undefined;
    const notes: string[] = [];
    const named = spaces.length > 1 || (vecName !== null && vecName !== 'default');
    if (named) notes.push(`Named vectors: ${spaces.map(([n]) => n).join(', ')}. The figures above are for '${vecName}'.`);
    const sampleVectors = (sample.objects?.[0]?.vectors ?? {}) as Record<string, ArrayLike<number>>;
    if (tenants) notes.push(tenant ? `Multi-tenant: counts are for tenant '${tenant}'.` : 'Multi-tenant collection with no tenants yet.');
    return {
      name,
      recordCount: typeof total.totalCount === 'number' ? total.totalCount : null,
      countIsEstimate: false,
      dimension: first ? first.length : null,
      metric: normaliseMetric(vec?.indexConfig?.distance ?? null),
      indexes: vec?.indexType ? [{ type: normaliseIndexType(vec.indexType), detail: `${vec.indexType} (${vec.indexConfig?.distance ?? 'distance not stated'})` }] : [],
      fields: ((config.properties ?? []) as Array<{ name: string; dataType: string }>).map((p) => ({ name: p.name, type: p.dataType })),
      notes,
      ...(named ? { vectors: spaces.map(([n, c]) => ({ name: n, dimension: sampleVectors[n]?.length ?? null, metric: normaliseMetric(c?.indexConfig?.distance ?? null) })) } : {}),
      ...(tenants ? { partitions: tenants } : {}),
    };
  }

  readonly supportsSort = true;

  /** Weaviate pages by offset (its cursor API cannot be combined with filters); 10,000 deep at most by default. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    const collection = await this.handle(name, options.partition);
    const r = (await collection.query.fetchObjects({
      limit: options.limit + 1,
      offset,
      filters: this.filters(collection, options.filter),
      includeVector: true,
      ...(options.sort?.length ? { sort: options.sort.slice(1).reduce((chain: any, s) => chain.byProperty(s.field, s.direction === 'asc'), (collection as any).sort.byProperty(options.sort[0].field, options.sort[0].direction === 'asc')) } : {}),
    } as any)) as any;
    const objects = (r.objects ?? []) as any[];
    // Whole vectors (the map) must come from the same vector search and the overview use.
    const vectorName = options.withVectors ? await this.vectorFor(name, options.vectorName) : options.vectorName;
    return {
      records: objects.slice(0, options.limit).map((o) => ({ id: String(o.uuid), metadata: trimMetadata((o.properties as Record<string, unknown>) ?? {}), ...vectorFields(this.firstVector(o, vectorName), options.withVectors) })),
      nextCursor: objects.length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: ExplorerVectorQuery): Promise<VectorSearchResult[]> {
    const collection = await this.handle(name, query.partition);
    const targetVector = await this.vectorFor(name, query.vectorName);
    const r = (await collection.query.nearVector(query.vector, { limit: query.topK, filters: this.filters(collection, query.filter), returnMetadata: ['distance'], ...(targetVector ? { targetVector } : {}) } as any)) as any;
    return ((r.objects ?? []) as any[]).map((o) => ({ id: String(o.uuid), score: 1 - (o.metadata?.distance ?? 0), metadata: trimMetadata((o.properties as Record<string, unknown>) ?? {}) }));
  }

  readonly keywordRanking = 'Weaviate BM25 over the searchable text properties';

  async keywordSearch(name: string, query: ExplorerKeywordQuery): Promise<VectorSearchResult[]> {
    const collection = await this.handle(name, query.partition);
    const r = (await collection.query.bm25(query.text, { limit: query.topK, filters: this.filters(collection, query.filter), returnMetadata: ['score'] } as any)) as any;
    return ((r.objects ?? []) as any[]).map((o) => ({ id: String(o.uuid), score: Number(o.metadata?.score ?? 0), metadata: trimMetadata((o.properties as Record<string, unknown>) ?? {}) }));
  }

  readonly nativeHybridRanking = 'Weaviate hybrid - BM25 and vector search fused by Weaviate (relative score fusion), weighted by the slider';

  /** Weaviate's own hybrid search: alpha 1 = vector only, 0 = BM25 only. */
  async nativeHybrid(name: string, query: ExplorerNativeHybridQuery): Promise<VectorSearchResult[]> {
    const collection = await this.handle(name, query.partition);
    const targetVector = await this.vectorFor(name, query.vectorName);
    const r = (await collection.query.hybrid(query.text, {
      alpha: query.alpha,
      vector: query.vector,
      limit: query.topK,
      filters: this.filters(collection, query.filter),
      returnMetadata: ['score'],
      ...(targetVector ? { targetVector } : {}),
    } as any)) as any;
    return ((r.objects ?? []) as any[]).map((o) => ({ id: String(o.uuid), score: Number(o.metadata?.score ?? 0), metadata: trimMetadata((o.properties as Record<string, unknown>) ?? {}) }));
  }

  async getRecord(name: string, id: string, { vectorName, partition }: RecordReadOptions = {}): Promise<ExplorerRecordDetail | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const collection = await this.handle(name, partition);
    const o = (await collection.query.fetchObjectById(id, { includeVector: true } as any)) as any;
    return o ? recordDetail(String(o.uuid), (o.properties as Record<string, unknown>) ?? {}, this.firstVector(o, await this.vectorFor(name, vectorName))) : null;
  }
}
