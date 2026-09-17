import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import {
  SchemaDefinition,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexTuningParameter, MetadataFieldDefinition } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';

/**
 * Connects to the customer's target PostgreSQL+pgvector instance - a
 * completely separate database from the app's own metadata store (which is
 * configured via APP_DB_* and managed by TypeORM). Connection details come
 * only from TARGET_PG_* environment variables, never hard-coded or persisted
 * by the app itself. The pool is created lazily so the app can boot and run
 * every other feature even when no target database has been configured yet.
 *
 * `upsert`/`search`/`deleteById` assume the simple (id, embedding, metadata
 * JSONB) shape created by `createSchema` here - Sprint 6's ingestion pipeline
 * owns mapping structured metadata fields, batching, and retries on top of
 * this adapter.
 */
@Injectable()
export class PostgresVectorAdapter implements VectorDatabaseAdapter, OnModuleDestroy {
  readonly platformId = 'postgres_pgvector' as const;
  private readonly logger = new Logger(PostgresVectorAdapter.name);
  private pool: Pool | null = null;
  private hasPgvectorCache: boolean | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaGenerator: SchemaGeneratorService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private getPool(): Pool {
    if (!this.pool) {
      const host = this.config.get<string>('TARGET_PG_HOST');
      if (!host) {
        throw new BadRequestException(
          'PostgreSQL target is not configured. Set TARGET_PG_HOST/PORT/USER/PASSWORD/DATABASE and retry.',
        );
      }
      this.pool = new Pool({
        host,
        port: this.config.get<number>('TARGET_PG_PORT', 5432),
        user: this.config.get<string>('TARGET_PG_USER'),
        password: this.config.get<string>('TARGET_PG_PASSWORD'),
        database: this.config.get<string>('TARGET_PG_DATABASE'),
        ssl: this.config.get<string>('TARGET_PG_SSL') === 'true' ? { rejectUnauthorized: false } : undefined,
        max: 5,
      });
    }
    return this.pool;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getPool().query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.error(`Postgres health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Some target servers (e.g. a fresh Windows Postgres install with no
   * pgvector build available) can't run `CREATE EXTENSION vector` at all.
   * Rather than hard-fail every Phase 4-6 action, cache a one-time capability
   * check and fall back to a plain array column + application-side cosine
   * similarity (see `searchFallback`) so the platform stays usable - with a
   * clear log that ANN indexing/GUC tuning are unavailable in this mode.
   */
  private async hasPgvector(): Promise<boolean> {
    if (this.hasPgvectorCache === null) {
      try {
        await this.getPool().query('CREATE EXTENSION IF NOT EXISTS vector');
        this.hasPgvectorCache = true;
      } catch (error) {
        this.logger.warn(
          `pgvector is not available on this target Postgres server (${(error as Error).message}). ` +
            'Falling back to a plain array column and application-side similarity search - no ANN index, no GUC tuning.',
        );
        this.hasPgvectorCache = false;
      }
    }
    return this.hasPgvectorCache;
  }

  private plainColumnType(type: MetadataFieldDefinition['type']): string {
    const types: Record<MetadataFieldDefinition['type'], string> = {
      string: 'TEXT',
      number: 'DOUBLE PRECISION',
      boolean: 'BOOLEAN',
      date: 'TIMESTAMPTZ',
      json: 'JSONB',
    };
    return types[type];
  }

  async createSchema(definition: SchemaDefinition): Promise<void> {
    if (await this.hasPgvector()) {
      const { postgres_pgvector } = this.schemaGenerator.generateAll({
        collectionName: definition.collectionOrTableName,
        dimension: definition.dimension,
        metadataFields: definition.metadataFields as SchemaDefinition['metadataFields'] as any,
      });
      await this.getPool().query(postgres_pgvector.ddl);
      return;
    }

    const table = sanitizeSqlIdentifier(definition.collectionOrTableName, 'collectionOrTableName');
    const fields = (definition.metadataFields as unknown as MetadataFieldDefinition[]).map((f) => ({
      ...f,
      name: sanitizeSqlIdentifier(f.name, `metadataField '${f.name}'`),
    }));
    const columns = fields.map((f) => `  ${f.name} ${this.plainColumnType(f.type)}`).join(',\n');
    const ddl = [
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      // TEXT, not UUID: the ingestion pipeline supplies its own composite
      // "documentId::chunkIndex" record IDs, which are never valid UUIDs.
      `  id TEXT PRIMARY KEY,`,
      `  embedding DOUBLE PRECISION[] NOT NULL,`,
      columns ? `${columns},` : '',
      `  created_at TIMESTAMPTZ DEFAULT now()`,
      `);`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    await this.getPool().query(ddl);
  }

  /**
   * `createSchema` deploys one typed column per metadata field (Phase 2's
   * design), not a single JSON blob - so upsert maps `record.metadata`'s own
   * keys onto those columns dynamically rather than assuming a fixed shape.
   * All records in one call must share the same metadata keys (a single
   * ingestion batch normally does); Sprint 6's ingestion pipeline is
   * responsible for grouping batches accordingly.
   */
  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[]): Promise<void> {
    if (!(await this.hasPgvector())) {
      this.logger.warn(
        `Skipping ANN index creation on '${collectionOrTableName}' - pgvector is not available on this target server. ` +
          'Search will do a full application-side scan until pgvector is installed.',
      );
      return;
    }
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.POSTGRES_PGVECTOR, collectionOrTableName, indexType, parameters);
    await this.getPool().query(artifact.statement);
    if (artifact.notes.length > 0) {
      this.logger.log(`Vector index created on '${collectionOrTableName}'. Notes: ${artifact.notes.join(' ')}`);
    }
  }

  async upsert(collectionOrTableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    const metadataKeys = Object.keys(records[0].metadata).map((k) => sanitizeSqlIdentifier(k, `metadata field '${k}'`));
    const columns = ['id', 'embedding', ...metadataKeys];
    const updateClause = metadataKeys.map((k) => `${k} = EXCLUDED.${k}`).concat('embedding = EXCLUDED.embedding').join(', ');
    // pgvector's input function accepts the same text form JSON.stringify produces
    // for a plain number[] ("[1,2,3]"); a plain double precision[] column instead
    // needs node-postgres's own array serialization, so pass the array as-is.
    const usePgvector = await this.hasPgvector();

    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        const values = [record.id, usePgvector ? JSON.stringify(record.vector) : record.vector, ...metadataKeys.map((k) => (record.metadata as any)[k] ?? null)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${updateClause}`,
          values,
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async search(collectionOrTableName: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    if (!(await this.hasPgvector())) {
      return this.searchFallback(table, query);
    }
    const hasSearchParams = query.searchParams && Object.keys(query.searchParams).length > 0;
    const client = await this.getPool().connect();
    try {
      if (hasSearchParams) {
        await client.query('BEGIN');
        await this.applySearchParams(client, query.searchParams!);
      }
      const result = await client.query(
        `SELECT *, 1 - (embedding <=> $1) AS score
         FROM ${table}
         ORDER BY embedding <=> $1
         LIMIT $2`,
        [JSON.stringify(query.vector), query.topK],
      );
      if (hasSearchParams) {
        await client.query('COMMIT');
      }
      return result.rows.map((row) => {
        const { id, embedding, score, created_at, ...metadata } = row;
        return { id, score: Number(score), metadata };
      });
    } catch (error) {
      if (hasSearchParams) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * No pgvector, no `<=>` operator or ANN index - fetch every row and rank by
   * cosine similarity in application code instead. Correct at any scale,
   * just O(n) per query; `searchParams` (pgvector-only GUCs) has no meaning
   * here and is ignored.
   */
  private async searchFallback(table: string, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const result = await this.getPool().query(`SELECT * FROM ${table}`);
    const scored = result.rows.map((row) => {
      const { id, embedding, created_at, ...metadata } = row;
      return { id, score: this.cosineSimilarity(query.vector, embedding), metadata };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.topK);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * pgvector exposes efSearch/nprobe as session GUCs, not query parameters, so
   * they can't be bound with `$1`-style placeholders - the (validated,
   * truncated-to-integer) value is interpolated directly. `SET LOCAL` scopes
   * the change to the current transaction only, so it never leaks to
   * subsequent queries on a pooled connection.
   */
  private async applySearchParams(client: PoolClient, searchParams: Record<string, number>): Promise<void> {
    if (typeof searchParams.efSearch === 'number' && Number.isFinite(searchParams.efSearch)) {
      await client.query(`SET LOCAL hnsw.ef_search = ${Math.trunc(searchParams.efSearch)}`);
    }
    if (typeof searchParams.nprobe === 'number' && Number.isFinite(searchParams.nprobe)) {
      await client.query(`SET LOCAL ivfflat.probes = ${Math.trunc(searchParams.nprobe)}`);
    }
  }

  async deleteById(collectionOrTableName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    await this.getPool().query(`DELETE FROM ${table} WHERE id = ANY($1)`, [ids]);
  }

  async dropSchema(collectionOrTableName: string, confirm: boolean): Promise<void> {
    if (!confirm) {
      throw new BadRequestException('Refusing to drop a table without explicit confirmation (confirm must be true).');
    }
    const table = sanitizeSqlIdentifier(collectionOrTableName, 'collectionOrTableName');
    this.logger.warn(`Dropping Postgres table '${table}' (confirmed).`);
    await this.getPool().query(`DROP TABLE IF EXISTS ${table}`);
  }
}
