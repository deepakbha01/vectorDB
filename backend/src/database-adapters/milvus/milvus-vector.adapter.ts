import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataType, MilvusClient } from '@zilliz/milvus2-sdk-node';
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
import { BrowseOptions, ExplorerCollectionInfo, ExplorerPage, ExplorerRecordDetail, ExplorerVectorQuery, RecordReadOptions, VectorExplorer, VectorKind } from '../vector-explorer';
import { bitsToBytes, milvusExpr, normaliseIndexType, normaliseMetric, recordDetail, trimMetadata, vectorFields } from '../explorer-helpers';

const MILVUS_DATA_TYPES: Record<string, DataType> = {
  VarChar: DataType.VarChar,
  FloatVector: DataType.FloatVector,
  Double: DataType.Double,
  Bool: DataType.Bool,
  Int64: DataType.Int64,
  JSON: DataType.JSON,
};

/**
 * Connects to the customer's target Milvus cluster (typically deployed on
 * Kubernetes per Phase 4). Connection details come only from TARGET_MILVUS_*
 * environment variables. Unlike Postgres/Oracle, Milvus's own insert/search
 * APIs already take structured per-field data, so no dynamic-column mapping
 * trick is needed here - the schema generated in Phase 2 is used directly.
 */
@Injectable()
export class MilvusVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
  readonly platformId = 'milvus' as const;
  private readonly logger = new Logger(MilvusVectorAdapter.name);
  private client: MilvusClient | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  private getClient(): MilvusClient {
    if (!this.client) {
      const address = this.config.get<string>('TARGET_MILVUS_ADDRESS');
      if (!address) {
        throw new BadRequestException('Milvus target is not configured. Set TARGET_MILVUS_ADDRESS (and TOKEN, if required) and retry.');
      }
      const token = this.config.get<string>('TARGET_MILVUS_TOKEN');
      this.client = new MilvusClient({ address, token, ssl: this.config.get<string>('TARGET_MILVUS_SSL') === 'true' });
    }
    return this.client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.getClient().checkHealth();
      return result.isHealthy;
    } catch (error) {
      this.logger.error(`Milvus health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const { milvus } = this.schemaGenerator.generateAll({
      collectionName: definition.collectionOrTableName,
      dimension: definition.dimension,
      metric: definition.metric,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    const schemaFields = milvus.schema.fields as Array<Record<string, unknown>>;

    await this.getClient().createCollection({
      collection_name: milvus.schema.collection_name as string,
      fields: schemaFields.map((f) => ({
        ...f,
        data_type: MILVUS_DATA_TYPES[f.data_type as string],
      })) as any,
    });
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void> {
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.MILVUS, collection, indexType, parameters, metric);
    const config = JSON.parse(artifact.statement) as { field_name: string; index_type: string; metric_type: string; params: Record<string, unknown> };

    await this.getClient().createIndex({
      collection_name: collection,
      field_name: config.field_name,
      index_type: config.index_type,
      metric_type: config.metric_type,
      params: config.params as Record<string, string | number>,
    });
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    await this.getClient().upsert({
      collection_name: collection,
      data: records.map((r) => ({ id: r.id, embedding: r.vector, ...r.metadata })),
    });
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const searchParams: Record<string, number> = {};
    if (typeof query.searchParams?.efSearch === 'number') searchParams.ef = query.searchParams.efSearch;
    if (typeof query.searchParams?.nprobe === 'number') searchParams.nprobe = query.searchParams.nprobe;

    const result = await this.getClient().search({
      collection_name: collection,
      vector: query.vector,
      limit: query.topK,
      output_fields: ['*'],
      ...(Object.keys(searchParams).length > 0 ? { params: searchParams as any } : {}),
    });
    return (result.results as Array<Record<string, unknown>>).map((row) => {
      const { id, score, embedding, ...metadata } = row;
      return { id: String(id), score: Number(score), metadata };
    });
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    await this.getClient().delete({ collection_name: collection, ids });
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop a collection without explicit confirmation (confirm must be true).');
    }
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    this.logger.warn(`Dropping Milvus collection '${collection}' (confirmed).`);
    await this.getClient().dropCollection({ collection_name: collection });
  }

  // ------------------------------------------------------ Data Explorer (read-only)

  async listCollections(): Promise<string[]> {
    const r = (await this.getClient().showCollections()) as any;
    return ((r.data ?? []) as Array<{ name: string }>).map((c) => c.name).sort();
  }

  /** Milvus vector field types and the kind of vector each holds. */
  private static kindOf(dataType: string): VectorKind | null {
    const t = String(dataType);
    if (/sparse/i.test(t)) return 'sparse';
    if (/binary/i.test(t)) return 'binary';
    return /vector/i.test(t) ? 'dense' : null;
  }

  /**
   * The collection's fields: its primary key, every vector field (dense,
   * sparse or binary) and the scalar fields. `vectorField` is the default -
   * the first dense one.
   */
  private async schemaOf(name: string): Promise<{
    primary: string;
    vectorField: string | null;
    dimension: number | null;
    vectors: Array<{ name: string; kind: VectorKind; dimension: number | null }>;
    fields: Array<{ name: string; type: string }>;
  }> {
    const d = (await this.getClient().describeCollection({ collection_name: name })) as any;
    const fields = (d.schema?.fields ?? []) as Array<{ name: string; data_type: string; is_primary_key?: boolean; type_params?: Array<{ key: string; value: string }> }>;
    const vectors = fields
      .filter((f) => MilvusVectorAdapter.kindOf(f.data_type))
      .map((f) => {
        const dim = f.type_params?.find((p) => p.key === 'dim')?.value;
        return { name: f.name, kind: MilvusVectorAdapter.kindOf(f.data_type)!, dimension: dim ? Number(dim) : null };
      });
    const main = vectors.find((v) => v.kind === 'dense') ?? vectors[0];
    return {
      primary: fields.find((f) => f.is_primary_key)?.name ?? 'id',
      vectorField: main?.name ?? null,
      dimension: main?.dimension ?? null,
      vectors,
      fields: fields.filter((f) => !f.is_primary_key && !MilvusVectorAdapter.kindOf(f.data_type)).map((f) => ({ name: f.name, type: String(f.data_type) })),
    };
  }

  /** The vector field to read or search: the one asked for (it must exist), else the default. */
  private vectorOf(s: Awaited<ReturnType<MilvusVectorAdapter['schemaOf']>>, requested?: string): { name: string; kind: VectorKind } | null {
    if (!requested) {
      const main = s.vectors.find((v) => v.name === s.vectorField);
      return main ? { name: main.name, kind: main.kind } : null;
    }
    const v = s.vectors.find((x) => x.name === requested);
    if (!v) throw new BadRequestException(`The collection has no vector field '${requested}'.`);
    return { name: v.name, kind: v.kind };
  }

  readonly searchableKinds: VectorKind[] = ['sparse', 'binary'];

  /**
   * Browsing and search need the collection loaded into memory; the explorer
   * never loads it (that is an operational change), it says so instead.
   */
  private async requireLoaded(name: string): Promise<void> {
    const s = (await this.getClient().getLoadState({ collection_name: name })) as any;
    if (s?.state && !String(s.state).includes('Loaded')) {
      throw new BadRequestException(`Milvus collection '${name}' is not loaded, so it cannot be browsed or searched. Load it in Milvus first; the Data Explorer never loads collections itself.`);
    }
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const s = await this.schemaOf(name);
    const stats = (await this.getClient().getCollectionStatistics({ collection_name: name })) as any;
    const rowCount = (stats.stats as Array<{ key: string; value: string }> | undefined)?.find((x) => x.key === 'row_count')?.value ?? stats.data?.row_count;
    let indexes: ExplorerCollectionInfo['indexes'] = [];
    let metric: string | null = null;
    const notes: string[] = [];
    // Each index names its field, so each vector field gets its own metric.
    const metricOf = new Map<string, string | null>();
    try {
      const idx = (await this.getClient().describeIndex({ collection_name: name })) as any;
      for (const d of (idx.index_descriptions ?? []) as Array<{ field_name: string; params: Array<{ key: string; value: string }> }>) {
        const p = Object.fromEntries(d.params.map((x) => [x.key, x.value]));
        metric ??= normaliseMetric(p.metric_type);
        metricOf.set(d.field_name, normaliseMetric(p.metric_type ?? null));
        indexes.push({ type: normaliseIndexType(p.index_type ?? ''), detail: `${p.index_type ?? 'index'} on ${d.field_name}${p.params ? ` ${p.params}` : ''}` });
      }
    } catch {
      indexes = [];
      notes.push('No index is built on this collection yet.');
    }
    notes.push('Milvus counts include rows not yet flushed; the figure can lag inserts slightly.');
    const many =s.vectors.length > 1 || s.vectors.some((v) => v.kind !== 'dense');
    if (many) notes.push(`Vector fields: ${s.vectors.map((v) => `${v.name} (${v.kind})`).join(', ')}. The figures above are for '${s.vectorField}'.`);
    return {
      name,
      recordCount: rowCount !== undefined ? Number(rowCount) : null,
      countIsEstimate: false,
      dimension: s.dimension,
      metric: metricOf.get(s.vectorField ?? '') ?? metric,
      indexes,
      fields: s.fields,
      notes,
      ...(many ? { vectors: s.vectors.map((v) => ({ name: v.name, dimension: v.dimension, metric: metricOf.get(v.name) ?? null, kind: v.kind })) } : {}),
    };
  }

  /** Milvus pages by offset (up to 16,384 rows deep); the cursor is that offset. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    if (offset + options.limit > 16_384) throw new BadRequestException('Milvus can page at most 16,384 rows deep; narrow the list with a filter.');
    await this.requireLoaded(name);
    const s = await this.schemaOf(name);
    const v = this.vectorOf(s, options.vectorName);
    const r = (await this.getClient().query({
      collection_name: name,
      filter: milvusExpr(options.filter),
      output_fields: [s.primary, ...s.fields.map((f) => f.name), ...(v ? [v.name] : [])],
      limit: options.limit + 1,
      offset,
    } as any)) as any;
    const rows = ((r.data ?? []) as Array<Record<string, unknown>>).slice(0, options.limit);
    return {
      records: rows.map((row) => {
        const { [s.primary]: id, ...rest } = row;
        const vec = v ? rest[v.name] : undefined;
        for (const x of s.vectors) delete rest[x.name];
        return { id: String(id), metadata: trimMetadata(rest), ...(v?.kind === 'dense' ? vectorFields(vec, options.withVectors) : { vectorPreview: null, dimension: null }) };
      }),
      nextCursor: (r.data ?? []).length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: ExplorerVectorQuery): Promise<VectorSearchResult[]> {
    await this.requireLoaded(name);
    const s = await this.schemaOf(name);
    const v = this.vectorOf(s, query.vectorName);
    if (!v) throw new BadRequestException('The collection has no vector field to search.');
    let data: unknown;
    if (v.kind === 'sparse') {
      if (!query.sparse) throw new BadRequestException(`'${v.name}' is a sparse vector field; search it with a sparse vector.`);
      // Milvus takes a sparse vector as index → weight.
      data = Object.fromEntries(query.sparse.indices.map((i, k) => [i, query.sparse!.values[k]]));
    } else if (v.kind === 'binary') {
      const bits = s.vectors.find((x) => x.name === v.name)?.dimension;
      if (bits && query.vector.length !== bits) throw new BadRequestException(`'${v.name}' holds ${bits} bits; the query has ${query.vector.length}.`);
      data = bitsToBytes(query.vector);
    } else data = query.vector;
    const expr = milvusExpr(query.filter);
    const r = (await this.getClient().search({
      collection_name: name,
      data: [data],
      anns_field: v.name,
      limit: query.topK,
      output_fields: s.fields.map((f) => f.name),
      ...(expr ? { filter: expr } : {}),
    } as any)) as any;
    return ((r.results ?? []) as Array<Record<string, unknown>>).map((row) => {
      const { id, score, ...metadata } = row;
      for (const x of s.vectors) delete metadata[x.name];
      return { id: String(id ?? row[s.primary]), score: Number(score), metadata: trimMetadata(metadata) };
    });
  }

  async getRecord(name: string, id: string, options: RecordReadOptions = {}): Promise<ExplorerRecordDetail | null> {
    await this.requireLoaded(name);
    const s = await this.schemaOf(name);
    const v = this.vectorOf(s, options.vectorName);
    const d = (await this.getClient().describeCollection({ collection_name: name })) as any;
    const numeric = /int/i.test(String(((d.schema?.fields ?? []) as any[]).find((f) => f.is_primary_key)?.data_type));
    if (numeric && !/^-?\d+$/.test(id)) return null;
    const literal = numeric ? id : `"${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const r = (await this.getClient().query({
      collection_name: name,
      filter: `${s.primary} == ${literal}`,
      output_fields: [s.primary, ...s.fields.map((f) => f.name), ...(v ? [v.name] : [])],
      limit: 1,
    } as any)) as any;
    const row = (r.data ?? [])[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const { [s.primary]: rid, ...rest } = row;
    const vec = v ? rest[v.name] : undefined;
    for (const x of s.vectors) delete rest[x.name];
    return recordDetail(String(rid), rest, vec, v?.kind ?? 'dense');
  }
}
