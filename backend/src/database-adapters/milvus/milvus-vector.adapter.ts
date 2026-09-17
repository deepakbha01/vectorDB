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
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

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
export class MilvusVectorAdapter implements VectorDatabaseAdapter {
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

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    const collection = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.MILVUS, collection, indexType, parameters);
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
}
