import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
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
import { esFilter, normaliseIndexType, normaliseMetric, trimMetadata, vectorFields } from '../explorer-helpers';

/**
 * Connects to the customer's target Elasticsearch/OpenSearch cluster
 * (self-hosted via ECK on Kubernetes, or a managed service). Connection
 * details come only from TARGET_ELASTICSEARCH_* environment variables.
 */
@Injectable()
export class ElasticsearchVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
  readonly platformId = 'elasticsearch' as const;
  private readonly logger = new Logger(ElasticsearchVectorAdapter.name);
  private client: Client | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  private getClient(): Client {
    if (!this.client) {
      const node = this.config.get<string>('TARGET_ELASTICSEARCH_NODE');
      if (!node) {
        throw new BadRequestException('Elasticsearch target is not configured. Set TARGET_ELASTICSEARCH_NODE (and _API_KEY, if required) and retry.');
      }
      const apiKey = this.config.get<string>('TARGET_ELASTICSEARCH_API_KEY');
      const username = this.config.get<string>('TARGET_ELASTICSEARCH_USERNAME');
      const password = this.config.get<string>('TARGET_ELASTICSEARCH_PASSWORD');
      this.client = new Client({
        node,
        auth: apiKey ? { apiKey } : username && password ? { username, password } : undefined,
      });
    }
    return this.client;
  }

  private indexName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const health = await this.getClient().cluster.health();
      return health.status !== 'red';
    } catch (error) {
      this.logger.error(`Elasticsearch health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const { elasticsearch } = this.schemaGenerator.generateAll({
      collectionName: definition.collectionOrTableName,
      dimension: definition.dimension,
      metric: definition.metric,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    const spec = elasticsearch.schema as { index: string; mappings: Record<string, unknown> };
    await this.getClient().indices.create({ index: spec.index, mappings: spec.mappings as any });
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void> {
    const index = this.indexName(collectionOrTableName);
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.ELASTICSEARCH, index, indexType, parameters, metric);
    const config = JSON.parse(artifact.statement) as { index_options: Record<string, unknown> };
    // index_options for an existing dense_vector field can only be updated by closing the index first.
    await this.getClient().indices.close({ index });
    await this.getClient().indices.putMapping({
      index,
      properties: { embedding: { type: 'dense_vector', index_options: config.index_options } } as any,
    });
    await this.getClient().indices.open({ index });
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const index = this.indexName(collectionOrTableName);
    const operations = records.flatMap((r) => [{ index: { _index: index, _id: r.id } }, { embedding: r.vector, ...r.metadata }]);
    const result = await this.getClient().bulk({ operations });
    if (result.errors) {
      const firstError = result.items.find((i: any) => i.index?.error)?.index?.error;
      throw new Error(`Elasticsearch bulk upsert had errors: ${JSON.stringify(firstError)}`);
    }
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const index = this.indexName(collectionOrTableName);
    const numCandidates = query.searchParams?.efSearch ?? Math.max(query.topK * 10, 100);
    const result = await this.getClient().search({
      index,
      knn: {
        field: 'embedding',
        query_vector: query.vector,
        k: query.topK,
        num_candidates: numCandidates,
        filter: query.filter as any,
      },
    } as any);
    return result.hits.hits.map((h: any) => {
      const { embedding, ...metadata } = h._source ?? {};
      return { id: h._id, score: h._score ?? 0, metadata };
    });
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const index = this.indexName(collectionOrTableName);
    const operations = ids.map((id) => ({ delete: { _index: index, _id: id } }));
    await this.getClient().bulk({ operations });
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to delete an index without explicit confirmation (confirm must be true).');
    }
    const index = this.indexName(collectionOrTableName);
    this.logger.warn(`Deleting Elasticsearch index '${index}' (confirmed).`);
    await this.getClient().indices.delete({ index });
  }

  // ------------------------------------------------------ Data Explorer (read-only)

  /** An index's field mappings and its (first) dense_vector field. */
  private async mappingOf(index: string): Promise<{ vectorField: string | null; vector: any; properties: Record<string, any> }> {
    const m = (await this.getClient().indices.getMapping({ index })) as any;
    const properties = (Object.values(m)[0] as any)?.mappings?.properties ?? {};
    const entry = Object.entries(properties).find(([, p]: [string, any]) => p?.type === 'dense_vector');
    return { vectorField: entry?.[0] ?? null, vector: entry?.[1] ?? null, properties };
  }

  /** Open, non-system indices that hold a dense_vector field. */
  async listCollections(): Promise<string[]> {
    const m = (await this.getClient().indices.getMapping({ index: '*', expand_wildcards: 'open' } as any)) as any;
    return Object.entries(m)
      .filter(([name, v]: [string, any]) => !name.startsWith('.') && Object.values(v?.mappings?.properties ?? {}).some((p: any) => p?.type === 'dense_vector'))
      .map(([name]) => name)
      .sort();
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const { vectorField, vector, properties } = await this.mappingOf(name);
    const count = (await this.getClient().count({ index: name })) as any;
    const indexType = vector?.index === false ? null : vector?.index_options?.type ?? null;
    return {
      name,
      recordCount: typeof count.count === 'number' ? count.count : null,
      countIsEstimate: false,
      dimension: typeof vector?.dims === 'number' ? vector.dims : null,
      metric: normaliseMetric(vector?.similarity ?? null),
      indexes: indexType ? [{ type: normaliseIndexType(indexType), detail: `${indexType} on ${vectorField}${vector.index_options ? ` ${JSON.stringify(vector.index_options)}` : ''}` }] : [],
      fields: Object.entries(properties)
        .filter(([f, p]: [string, any]) => f !== vectorField && p?.type)
        .map(([f, p]: [string, any]) => ({ name: f, type: String(p.type) })),
      notes: vector && !vector.index_options && vector.index !== false ? ['The index type is the cluster default for dense_vector.'] : [],
    };
  }

  /** Elasticsearch pages by offset (from + size), 10,000 deep at most by default. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    if (offset + options.limit > 10_000) throw new BadRequestException('Elasticsearch pages at most 10,000 records deep; narrow the list with a filter.');
    const { vectorField } = await this.mappingOf(name);
    const info = await this.describeCollection(name);
    const clauses = esFilter(options.filter, info.fields);
    const r = (await this.getClient().search({ index: name, from: offset, size: options.limit + 1, query: clauses.length ? { bool: { filter: clauses } } : { match_all: {} } } as any)) as any;
    const hits = (r.hits?.hits ?? []) as any[];
    return {
      records: hits.slice(0, options.limit).map((h) => {
        const { [vectorField ?? 'embedding']: vec, ...metadata } = h._source ?? {};
        return { id: String(h._id), metadata: trimMetadata(metadata), ...vectorFields(vec, options.withVectors) };
      }),
      nextCursor: hits.length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const { vectorField } = await this.mappingOf(name);
    const info = await this.describeCollection(name);
    const clauses = esFilter(query.filter, info.fields);
    const r = (await this.getClient().search({
      index: name,
      knn: { field: vectorField ?? 'embedding', query_vector: query.vector, k: query.topK, num_candidates: Math.max(query.topK * 10, 100), ...(clauses.length ? { filter: { bool: { filter: clauses } } } : {}) },
    } as any)) as any;
    return ((r.hits?.hits ?? []) as any[]).map((h) => {
      const { [vectorField ?? 'embedding']: _vec, ...metadata } = h._source ?? {};
      return { id: String(h._id), score: h._score ?? 0, metadata: trimMetadata(metadata) };
    });
  }
}
