import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Float64, Bool, Schema, TimestampMillisecond, Utf8 } from 'apache-arrow';
import {
  SchemaDefinition,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { IndexTuningParameter, MetadataFieldDefinition } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/** Escapes a value for use inside a LanceDB SQL-like `delete`/`where` predicate string. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Connects to the customer's configured LanceDB dataset - an embedded
 * library, not a server: this process reads/writes the dataset directly at a
 * local path or object storage URI (see Phase 4 notes). Connection details
 * come only from TARGET_LANCEDB_URI environment variable.
 */
@Injectable()
export class LanceDbVectorAdapter implements VectorDatabaseAdapter {
  readonly platformId = 'lancedb' as const;
  private readonly logger = new Logger(LanceDbVectorAdapter.name);
  private connection: lancedb.Connection | null = null;

  constructor(private readonly config: ConfigService) {}

  private async getConnection(): Promise<lancedb.Connection> {
    if (!this.connection) {
      const uri = this.config.get<string>('TARGET_LANCEDB_URI');
      if (!uri) {
        throw new BadRequestException('LanceDB target is not configured. Set TARGET_LANCEDB_URI (a local path or S3/GCS URI) and retry.');
      }
      this.connection = await lancedb.connect(uri);
    }
    return this.connection;
  }

  private tableName(collectionOrTableName: string): string {
    return sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
  }

  async healthCheck(): Promise<boolean> {
    try {
      await (await this.getConnection()).tableNames();
      return true;
    } catch (error) {
      this.logger.error(`LanceDB health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const arrowTypes: Record<MetadataFieldDefinition['type'], () => any> = {
      string: () => new Utf8(),
      number: () => new Float64(),
      boolean: () => new Bool(),
      date: () => new TimestampMillisecond(),
      json: () => new Utf8(),
    };
    const fields = [
      new Field('id', new Utf8(), false),
      new Field('embedding', new FixedSizeList(definition.dimension, new Field('item', new Float32(), true)), false),
      ...(definition.metadataFields as unknown as MetadataFieldDefinition[]).map((f) => new Field(f.name, arrowTypes[f.type](), true)),
    ];
    const connection = await this.getConnection();
    await connection.createEmptyTable(this.tableName(definition.collectionOrTableName), new Schema(fields), { mode: 'create', existOk: false } as any);
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    const p = (name: string) => parameters.find((x) => x.name === name)?.value;
    const table = await (await this.getConnection()).openTable(this.tableName(collectionOrTableName));
    if (indexType === IndexType.HNSW) {
      await table.createIndex('embedding', { config: lancedb.Index.hnswSq({ m: p('M'), efConstruction: p('efConstruction') }) } as any);
    } else {
      await table.createIndex('embedding', {
        config: lancedb.Index.ivfPq({ numPartitions: p('nlist'), numSubVectors: p('m') }),
      } as any);
    }
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const table = await (await this.getConnection()).openTable(this.tableName(collectionOrTableName));
    // LanceDB's merge-insert is the closest equivalent to an upsert (plain add() always appends).
    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(records.map((r) => ({ id: r.id, embedding: r.vector, ...r.metadata })));
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const table = await (await this.getConnection()).openTable(this.tableName(collectionOrTableName));
    let search = (table.search(query.vector, 'vector') as lancedb.VectorQuery).distanceType('cosine').limit(query.topK);
    if (typeof query.searchParams?.nprobe === 'number') {
      search = search.nprobes(query.searchParams.nprobe);
    }
    const rows = await search.toArray();
    return rows.map((row: any) => {
      const { id, embedding, _distance, ...metadata } = row;
      return { id: String(id), score: 1 - Number(_distance ?? 0), metadata };
    });
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = await (await this.getConnection()).openTable(this.tableName(collectionOrTableName));
    await table.delete(`id IN (${ids.map(sqlLiteral).join(', ')})`);
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop a table without explicit confirmation (confirm must be true).');
    }
    const name = this.tableName(collectionOrTableName);
    this.logger.warn(`Dropping LanceDB table '${name}' (confirmed).`);
    await (await this.getConnection()).dropTable(name);
  }
}
