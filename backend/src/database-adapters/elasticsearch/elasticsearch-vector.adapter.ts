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
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/**
 * Connects to the customer's target Elasticsearch/OpenSearch cluster
 * (self-hosted via ECK on Kubernetes, or a managed service). Connection
 * details come only from TARGET_ELASTICSEARCH_* environment variables.
 */
@Injectable()
export class ElasticsearchVectorAdapter implements VectorDatabaseAdapter {
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
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    const spec = elasticsearch.schema as { index: string; mappings: Record<string, unknown> };
    await this.getClient().indices.create({ index: spec.index, mappings: spec.mappings as any });
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    const index = this.indexName(collectionOrTableName);
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.ELASTICSEARCH, index, indexType, parameters);
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
}
