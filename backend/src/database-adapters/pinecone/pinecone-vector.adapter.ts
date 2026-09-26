import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pinecone } from '@pinecone-database/pinecone';
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
import { fieldsFromSample, normaliseMetric, pineconeFilter, trimMetadata, vectorFields } from '../explorer-helpers';

/**
 * Connects to the customer's target Pinecone project. Connection details come
 * only from TARGET_PINECONE_* environment variables. Pinecone manages ANN
 * indexing internally (see Phase 3 notes), so `createVectorIndex` is a no-op -
 * the index's dimension/metric are fixed at `createSchema` time.
 *
 * Uses Pinecone SDK v9's classic (dimension/metric/spec) index-creation shape
 * rather than its newer schema/deployment API - this matches the Phase 2
 * generated schema directly and remains fully supported, though marked
 * deprecated in favor of the schema-based API for new hybrid/full-text-search
 * use cases this platform does not need.
 */
@Injectable()
export class PineconeVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
  readonly platformId = 'pinecone' as const;
  private readonly logger = new Logger(PineconeVectorAdapter.name);
  private client: Pinecone | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Pinecone {
    if (!this.client) {
      const apiKey = this.config.get<string>('TARGET_PINECONE_API_KEY');
      if (!apiKey) {
        throw new BadRequestException('Pinecone target is not configured. Set TARGET_PINECONE_API_KEY and retry.');
      }
      this.client = new Pinecone({ apiKey });
    }
    return this.client;
  }

  /** Pinecone index names must be lowercase alphanumeric/hyphen - unlike SQL identifiers, underscores are not allowed. */
  private indexName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName').replace(/_/g, '-');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const indexName = this.config.get<string>('TARGET_PINECONE_INDEX');
      if (!indexName) {
        return false;
      }
      await this.getClient().index(indexName).describeIndexStats();
      return true;
    } catch (error) {
      this.logger.error(`Pinecone health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const name = this.indexName(definition.collectionOrTableName);
    const cloud = this.config.get<string>('TARGET_PINECONE_CLOUD', 'aws');
    const region = this.config.get<string>('TARGET_PINECONE_REGION', 'us-east-1');
    await this.getClient().indexes.create({
      name,
      dimension: definition.dimension,
      metric: 'cosine',
      spec: { serverless: { cloud, region } },
      waitUntilReady: true,
    } as Parameters<Pinecone['indexes']['create']>[0]);
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, _parameters: IndexTuningParameter[]): Promise<void> {
    this.logger.log(
      `Pinecone manages ANN indexing internally - the Phase 3 decision (${indexType}) for '${collectionOrTableName}' has no separate ` +
        'index-creation call; dimension/metric were already set in createSchema.',
    );
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const index = this.getClient().index(this.indexName(collectionOrTableName));
    await index.upsert({ records: records.map((r) => ({ id: r.id, values: r.vector, metadata: r.metadata as any })) } as any);
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const index = this.getClient().index(this.indexName(collectionOrTableName));
    const result = await index.query({
      vector: query.vector,
      topK: query.topK,
      includeMetadata: true,
      filter: query.filter as any,
    } as any);
    return (result.matches ?? []).map((m: any) => ({ id: m.id, score: m.score ?? 0, metadata: (m.metadata as Record<string, unknown>) ?? {} }));
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const index = this.getClient().index(this.indexName(collectionOrTableName));
    await index.deleteMany({ ids } as any);
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to delete an index without explicit confirmation (confirm must be true).');
    }
    const name = this.indexName(collectionOrTableName);
    this.logger.warn(`Deleting Pinecone index '${name}' (confirmed).`);
    await this.getClient().indexes.delete(name);
  }

  // ------------------------------------------------------ Data Explorer (read-only)

  /** createSchema turns underscores into hyphens (Pinecone index names). */
  designedName(designName: string): string {
    return this.indexName(designName);
  }

  async listCollections(): Promise<string[]> {
    const r = (await this.getClient().listIndexes()) as any;
    return ((r.indexes ?? []) as Array<{ name: string }>).map((i) => i.name).sort();
  }

  /** One page of ids from Pinecone's list endpoint, then their values and metadata. Serverless indexes only. */
  private async page(name: string, limit: number, token: string | null): Promise<{ records: Array<{ id: string; values?: number[]; metadata?: Record<string, unknown> }>; next: string | null }> {
    const index = this.getClient().index(name) as any;
    const listed = await index.listPaginated({ limit, ...(token ? { paginationToken: token } : {}) });
    const ids = ((listed.vectors ?? []) as Array<{ id: string }>).map((v) => v.id);
    if (!ids.length) return { records: [], next: null };
    const fetched = await index.fetch({ ids });
    const byId = (fetched.records ?? {}) as Record<string, { id: string; values?: number[]; metadata?: Record<string, unknown> }>;
    return { records: ids.map((id) => byId[id] ?? { id }), next: listed.pagination?.next ?? null };
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const d = (await this.getClient().describeIndex(name)) as any;
    const stats = (await this.getClient().index(name).describeIndexStats()) as any;
    const notes: string[] = ['Pinecone has no fixed schema: fields are those seen in the first 20 records.'];
    let sample: Array<Record<string, unknown>> = [];
    try {
      sample = (await this.page(name, 20, null)).records.map((r) => r.metadata ?? {});
    } catch {
      notes.push('This index cannot list its records (pod-based indexes cannot); browsing is unavailable, search still works.');
    }
    const kind = d.spec?.serverless ? 'serverless' : d.spec?.pod ? 'pod-based' : 'managed';
    return {
      name,
      recordCount: typeof stats.totalRecordCount === 'number' ? stats.totalRecordCount : null,
      countIsEstimate: false,
      dimension: typeof d.dimension === 'number' ? d.dimension : null,
      metric: normaliseMetric(d.metric ?? null),
      indexes: [{ type: 'managed', detail: `${kind} index; Pinecone chooses and tunes the ANN index` }],
      fields: fieldsFromSample(sample),
      notes,
    };
  }

  /** Pinecone lists records by id only - it cannot filter a listing, so filters apply to search. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    if (Object.keys(options.filter).length) throw new BadRequestException('Pinecone cannot filter a record listing; use Search to filter.');
    const p = await this.page(name, options.limit, options.cursor);
    return {
      records: p.records.map((r) => ({ id: r.id, metadata: trimMetadata(r.metadata ?? {}), ...vectorFields(r.values, options.withVectors) })),
      nextCursor: p.next,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const r = (await this.getClient()
      .index(name)
      .query({ vector: query.vector, topK: query.topK, includeMetadata: true, filter: pineconeFilter(query.filter) } as any)) as any;
    return ((r.matches ?? []) as any[]).map((m) => ({ id: m.id, score: m.score ?? 0, metadata: trimMetadata((m.metadata as Record<string, unknown>) ?? {}) }));
  }
}
