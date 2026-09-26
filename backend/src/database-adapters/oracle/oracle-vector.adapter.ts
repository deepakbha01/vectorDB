import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import oracledb, { Pool } from 'oracledb';
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
import { splitSqlStatements } from '../../common/sql-statements';
import { BrowseOptions, ExplorerCollectionInfo, ExplorerFilter, ExplorerPage, VectorExplorer } from '../vector-explorer';
import { oracleWhere, trimMetadata, vectorFields } from '../explorer-helpers';

/** Oracle 23ai vector index subtypes → the Index Design choices. */
const ORACLE_INDEX_SUBTYPE: Record<string, string> = { INMEMORY_NEIGHBOR_GRAPH: 'hnsw', NEIGHBOR_PARTITIONS: 'ivf_flat' };

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

function lowercaseKeys(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * Connects to the customer's target Oracle Database (23ai+ for native VECTOR
 * support) via the oracledb driver's Thin mode - no Oracle Instant Client
 * install required. Connection details come only from TARGET_ORACLE_*
 * environment variables. See PostgresVectorAdapter for the shared rationale
 * on why upsert/search map dynamically onto per-field metadata columns.
 */
@Injectable()
export class OracleVectorAdapter implements VectorDatabaseAdapter, VectorExplorer, OnModuleDestroy {
  readonly platformId = 'oracle' as const;
  private readonly logger = new Logger(OracleVectorAdapter.name);
  private pool: Pool | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool?.close(0);
  }

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      const connectString = this.config.get<string>('TARGET_ORACLE_CONNECT_STRING');
      if (!connectString) {
        throw new BadRequestException(
          'Oracle target is not configured. Set TARGET_ORACLE_USER/PASSWORD/CONNECT_STRING and retry.',
        );
      }
      this.pool = await oracledb.createPool({
        user: this.config.get<string>('TARGET_ORACLE_USER'),
        password: this.config.get<string>('TARGET_ORACLE_PASSWORD'),
        connectString,
        poolMin: 0,
        poolMax: 5,
      });
    }
    return this.pool;
  }

  async healthCheck(): Promise<boolean> {
    let connection;
    try {
      connection = await (await this.getPool()).getConnection();
      await connection.execute('SELECT 1 FROM DUAL');
      return true;
    } catch (error) {
      this.logger.error(`Oracle health check failed: ${(error as Error).message}`);
      return false;
    } finally {
      await connection?.close();
    }
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    const { oracle } = this.schemaGenerator.generateAll({
      collectionName: definition.collectionOrTableName,
      dimension: definition.dimension,
      metric: definition.metric,
      metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
    });
    const connection = await (await this.getPool()).getConnection();
    try {
      for (const statement of splitSqlStatements(oracle.ddl)) {
        await connection.execute(statement, [], { autoCommit: true });
      }
    } finally {
      await connection.close();
    }
  }

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void> {
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.ORACLE, collectionOrTableName, indexType, parameters, metric);
    const connection = await (await this.getPool()).getConnection();
    try {
      for (const statement of splitSqlStatements(artifact.statement)) {
        await connection.execute(statement, [], { autoCommit: true });
      }
    } finally {
      await connection.close();
    }
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const metadataKeys = Object.keys(records[0].metadata).map((k) => sanitizeSqlIdentifier(k, `metadata field '${k}'`));

    const usingCols = ['id', 'embedding', ...metadataKeys].map((c) => `:${c} AS ${c}`).join(', ');
    const updateSet = metadataKeys.concat('embedding').map((c) => `t.${c} = s.${c}`).join(', ');
    const insertCols = ['id', 'embedding', ...metadataKeys];
    const merge = `MERGE INTO ${table} t
       USING (SELECT ${usingCols} FROM dual) s ON (t.id = s.id)
       WHEN MATCHED THEN UPDATE SET ${updateSet}
       WHEN NOT MATCHED THEN INSERT (${insertCols.join(', ')}) VALUES (${insertCols.map((c) => `s.${c}`).join(', ')})`;

    const connection = await (await this.getPool()).getConnection();
    try {
      for (const record of records) {
        const binds: Record<string, any> = {
          id: record.id,
          embedding: { val: new Float32Array(record.vector), type: oracledb.DB_TYPE_VECTOR },
        };
        for (const key of metadataKeys) {
          const value = (record.metadata as any)[key];
          binds[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null;
        }
        await connection.execute(merge, binds, { autoCommit: true });
      }
    } finally {
      await connection.close();
    }
  }

  /**
   * `query.searchParams` (efSearch/nprobe) is intentionally not applied here.
   * Oracle's per-query approximate-search accuracy controls are not something
   * this project has verified a documented syntax for; rather than guess at
   * SQL that might be wrong, Oracle search runs with whatever accuracy was
   * baked in at index-creation time (Phase 3/4) until a real per-query
   * mechanism is confirmed and implemented.
   */
  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const connection = await (await this.getPool()).getConnection();
    try {
      const result = await connection.execute(
        `SELECT t.*, VECTOR_DISTANCE(embedding, :qvec, COSINE) AS distance
         FROM ${table} t
         ORDER BY distance
         FETCH FIRST :k ROWS ONLY`,
        { qvec: { val: new Float32Array(query.vector), type: oracledb.DB_TYPE_VECTOR }, k: query.topK },
      );
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
      return rows.map((raw) => {
        const row = lowercaseKeys(raw);
        const { id, embedding, distance, created_at, ...metadata } = row;
        return { id: id as string, score: 1 - Number(distance), metadata };
      });
    } finally {
      await connection.close();
    }
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const connection = await (await this.getPool()).getConnection();
    try {
      const placeholders = ids.map((_, i) => `:id${i}`).join(', ');
      const binds = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
      await connection.execute(`DELETE FROM ${table} WHERE id IN (${placeholders})`, binds, { autoCommit: true });
    } finally {
      await connection.close();
    }
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop a table without explicit confirmation (confirm must be true).');
    }
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    this.logger.warn(`Dropping Oracle table '${table}' (confirmed).`);
    const connection = await (await this.getPool()).getConnection();
    try {
      await connection.execute(`DROP TABLE ${table} PURGE`, [], { autoCommit: true });
    } finally {
      await connection.close();
    }
  }

  // ------------------------------------------------------ Data Explorer (read-only)

  private async query<T = Record<string, unknown>>(sql: string, binds: Record<string, unknown> | unknown[] = {}): Promise<T[]> {
    const connection = await (await this.getPool()).getConnection();
    try {
      return ((await connection.execute(sql, binds as any)).rows ?? []) as T[];
    } finally {
      await connection.close();
    }
  }

  /** Our tables are created unquoted, so Oracle stores them upper case; the explorer shows them lower case. */
  private upper(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name)) throw new BadRequestException(`Invalid table name '${name}'.`);
    return name.toUpperCase();
  }

  /** Tables owned by the connected user that have an EMBEDDING column. */
  async listCollections(): Promise<string[]> {
    const rows = await this.query<{ TABLE_NAME: string }>(`SELECT table_name FROM user_tab_columns WHERE column_name = 'EMBEDDING' ORDER BY table_name`);
    return rows.map((r) => r.TABLE_NAME.toLowerCase());
  }

  private async columnsOf(table: string): Promise<Array<{ name: string; type: string }>> {
    const rows = await this.query<{ COLUMN_NAME: string; DATA_TYPE: string }>(`SELECT column_name, data_type FROM user_tab_columns WHERE table_name = :t ORDER BY column_id`, { t: table });
    return rows.map((r) => ({ name: r.COLUMN_NAME, type: r.DATA_TYPE }));
  }

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const table = this.upper(name);
    const columns = await this.columnsOf(table);
    const notes: string[] = [];
    const dim = await this.query<{ D: number }>(`SELECT VECTOR_DIMENSION_COUNT(embedding) AS d FROM "${table}" FETCH FIRST 1 ROWS ONLY`);
    // Exact below a million rows; above that the optimizer statistics.
    const stats = await this.query<{ NUM_ROWS: number | null }>(`SELECT num_rows FROM user_tables WHERE table_name = :t`, { t: table });
    const estimate = stats[0]?.NUM_ROWS ?? null;
    let recordCount: number;
    let countIsEstimate = false;
    if (estimate !== null && estimate >= 1_000_000) {
      recordCount = Number(estimate);
      countIsEstimate = true;
    } else {
      recordCount = Number((await this.query<{ N: number }>(`SELECT COUNT(*) AS n FROM "${table}"`))[0].N);
    }
    let indexes: ExplorerCollectionInfo['indexes'] = [];
    try {
      const idx = await this.query<{ INDEX_NAME: string; INDEX_SUBTYPE: string | null }>(`SELECT index_name, index_subtype FROM user_indexes WHERE table_name = :t AND index_type = 'VECTOR'`, { t: table });
      indexes = idx.map((i) => ({ type: ORACLE_INDEX_SUBTYPE[i.INDEX_SUBTYPE ?? ''] ?? 'other', detail: `${i.INDEX_NAME} (${i.INDEX_SUBTYPE ?? 'vector index'})` }));
    } catch {
      notes.push('Vector indexes could not be read from USER_INDEXES on this database version.');
    }
    notes.push("The index's distance metric is not read here; searches here use cosine distance.");
    return {
      name,
      recordCount,
      countIsEstimate,
      dimension: dim[0]?.D !== undefined && dim[0]?.D !== null ? Number(dim[0].D) : null,
      metric: null,
      indexes,
      fields: columns.filter((c) => !['ID', 'EMBEDDING', 'CREATED_AT'].includes(c.name)).map((c) => ({ name: c.name.toLowerCase(), type: c.type })),
      notes,
    };
  }

  /** Pages in id order, continuing after the last id seen. */
  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const table = this.upper(name);
    const where = oracleWhere(options.filter, (await this.columnsOf(table)).map((c) => c.name));
    const conditions = [options.cursor === null ? null : 'id > :cur', where.sql || null].filter(Boolean);
    const binds: Record<string, unknown> = { ...where.binds, n: options.limit + 1, ...(options.cursor === null ? {} : { cur: options.cursor }) };
    const rows = (await this.query(`SELECT * FROM "${table}"${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id FETCH FIRST :n ROWS ONLY`, binds)).map(lowercaseKeys);
    const page = rows.slice(0, options.limit);
    return {
      records: page.map((row) => {
        const { id, embedding, created_at, ...metadata } = row;
        return { id: String(id), metadata: trimMetadata(metadata), ...vectorFields(embedding, options.withVectors) };
      }),
      nextCursor: rows.length > options.limit ? String(page[page.length - 1].id) : null,
    };
  }

  async searchFiltered(name: string, query: { vector: number[]; topK: number; filter: ExplorerFilter }): Promise<VectorSearchResult[]> {
    const table = this.upper(name);
    const where = oracleWhere(query.filter, (await this.columnsOf(table)).map((c) => c.name));
    const rows = await this.query(
      `SELECT t.*, VECTOR_DISTANCE(embedding, :qvec, COSINE) AS distance FROM "${table}" t${where.sql ? ` WHERE ${where.sql}` : ''} ORDER BY distance FETCH FIRST :k ROWS ONLY`,
      { ...where.binds, qvec: { val: new Float32Array(query.vector), type: oracledb.DB_TYPE_VECTOR }, k: query.topK },
    );
    return rows.map((raw) => {
      const { id, embedding, distance, created_at, ...metadata } = lowercaseKeys(raw);
      return { id: String(id), score: 1 - Number(distance), metadata: trimMetadata(metadata) };
    });
  }
}
