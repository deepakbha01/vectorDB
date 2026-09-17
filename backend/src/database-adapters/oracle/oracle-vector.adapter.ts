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
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';
import { splitSqlStatements } from '../../common/sql-statements';

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
export class OracleVectorAdapter implements VectorDatabaseAdapter, OnModuleDestroy {
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

  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.ORACLE, collectionOrTableName, indexType, parameters);
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
}
