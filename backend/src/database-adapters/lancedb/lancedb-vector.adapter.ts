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
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerPage, VectorExplorer } from '../vector-explorer';
import { lanceWhere, normaliseIndexType, trimMetadata, vectorFields } from '../explorer-helpers';

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
export class LanceDbVectorAdapter implements VectorDatabaseAdapter, VectorExplorer {
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

  // ------------------------------------------------------ Data Explorer (read-only)

  async listCollections(): Promise<string[]> {
    return (await (await this.getConnection()).tableNames()).sort();
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const table = await (await this.getConnection()).openTable(name);
    const schema = await table.schema();
    const embedding = schema.fields.find((f) => f.name === 'embedding');
    const indices = await table.listIndices();
    return {
      name,
      recordCount: await table.countRows(),
      countIsEstimate: false,
      dimension: (embedding?.type as unknown as { listSize?: number })?.listSize ?? null,
      // LanceDB's index listing does not state a metric; this platform's search uses cosine.
      metric: null,
      indexes: indices.filter((i) => i.columns.includes('embedding')).map((i) => ({ type: normaliseIndexType(i.indexType), detail: `${i.indexType} (${i.name})` })),
      fields: schema.fields.filter((f) => f.name !== 'id' && f.name !== 'embedding').map((f) => ({ name: f.name, type: String(f.type) })),
      notes: ['LanceDB does not report an index metric; searches here use cosine distance.'],
    };
  }

  /** Arrow rows → plain objects; the vector comes back as an Arrow vector. */
  private plainRow(row: any): Record<string, unknown> {
    const o: Record<string, unknown> = typeof row?.toJSON === 'function' ? row.toJSON() : { ...row };
    const e = o.embedding as any;
    if (e && typeof e.toArray === 'function') o.embedding = e.toArray();
    return o;
  }

  /** LanceDB pages by offset; order is the table's storage order (stable while the table does not change). */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    const table = await (await this.getConnection()).openTable(name);
    const where = lanceWhere(options.filter);
    let query = table.query();
    if (where) query = query.where(where);
    const rows = (await query.limit(options.limit + 1).offset(offset).toArray()).map((r) => this.plainRow(r));
    return {
      records: rows.slice(0, options.limit).map((row) => {
        const { id, embedding, ...metadata } = row;
        return { id: String(id), metadata: trimMetadata(metadata), ...vectorFields(embedding, options.withVectors) };
      }),
      nextCursor: rows.length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const table = await (await this.getConnection()).openTable(name);
    let search = (table.search(query.vector, 'vector') as lancedb.VectorQuery).distanceType('cosine').limit(query.topK);
    const where = lanceWhere(query.filter);
    if (where) search = search.where(where);
    return (await search.toArray()).map((r: any) => {
      const { id, embedding, _distance, ...metadata } = this.plainRow(r);
      return { id: String(id), score: 1 - Number(_distance ?? 0), metadata: trimMetadata(metadata) };
    });
  }
}
