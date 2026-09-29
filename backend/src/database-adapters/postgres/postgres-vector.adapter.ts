import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import {
  SchemaDefinition,
  SearchMode,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { SchemaGeneratorService } from '../../schema-generator/schema-generator.service';
import { IndexTuningParameter, MetadataFieldDefinition } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { SimilarityMetric } from '../../discovery/enums/discovery.enum';
import { sanitizeSqlIdentifier } from '../../common/identifier-sanitizer';
import { BrowseOptions, ExplorerCollectionInfo, ExplorerKeywordQuery, ExplorerPage, ExplorerRecordDetail, ExplorerVectorQuery, RecordReadOptions, VectorExplorer, VectorKind } from '../vector-explorer';
import { normaliseIndexType, normaliseMetric, pgWhere, recordDetail, trimMetadata, vectorFields } from '../explorer-helpers';

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
export class PostgresVectorAdapter implements VectorDatabaseAdapter, VectorExplorer, OnModuleDestroy {
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

  /** `exact_scan` when pgvector is missing: search() then compares every row in the application (searchFallback). */
  async searchMode(): Promise<SearchMode> {
    return (await this.hasPgvector()) ? 'ann' : 'exact_scan';
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
        metric: definition.metric,
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
  async createVectorIndex(collectionOrTableName: string, indexType: IndexType, parameters: IndexTuningParameter[], metric?: SimilarityMetric): Promise<void> {
    if (!(await this.hasPgvector())) {
      this.logger.warn(
        `Skipping ANN index creation on '${collectionOrTableName}' - pgvector is not available on this target server. ` +
          'Search will do a full application-side scan until pgvector is installed.',
      );
      return;
    }
    const artifact = this.schemaGenerator.generateIndexArtifact(VectorPlatform.POSTGRES_PGVECTOR, collectionOrTableName, indexType, parameters, metric);
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

  // ------------------------------------------------------ Data Explorer (read-only)

  /** Tables in the current schema with an `embedding` column - the shape createSchema deploys. */
  async listCollections(): Promise<string[]> {
    const r = await this.getPool().query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'embedding' ORDER BY table_name`,
    );
    return r.rows.map((x: { table_name: string }) => x.table_name);
  }

  private async columnsOf(table: string): Promise<Array<{ name: string; type: string }>> {
    const r = await this.getPool().query(
      `SELECT column_name AS name, udt_name AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    return r.rows;
  }

  /** pgvector column types, and the kind of vector each holds. */
  private static readonly VECTOR_TYPES: Record<string, VectorKind> = { vector: 'dense', halfvec: 'dense', sparsevec: 'sparse', bit: 'binary' };

  /** Vector columns besides `embedding` (e.g. a sparsevec for keyword weights, a bit column for binary codes). */
  private extraVectorColumns(columns: Array<{ name: string; type: string }>): Array<{ name: string; type: string; kind: VectorKind }> {
    return columns.filter((c) => c.name !== 'embedding' && PostgresVectorAdapter.VECTOR_TYPES[c.type]).map((c) => ({ ...c, kind: PostgresVectorAdapter.VECTOR_TYPES[c.type] }));
  }

  /**
   * A row as id, metadata (no vector columns) and the vector asked for (default
   * `embedding`). `scored`: the query added a computed score column, taken out of
   * the metadata; a listing has none, so a real column named score stays.
   */
  private splitRow(row: Record<string, unknown>, extra: string[], vectorName?: string, scored = false): { id: string; metadata: Record<string, unknown>; vec: unknown; score: unknown } {
    const { id, embedding, created_at, ...rest } = row;
    const vec = vectorName ? rest[vectorName] : embedding;
    const score = scored ? rest.score : undefined;
    if (scored) delete rest.score;
    for (const c of extra) delete rest[c];
    return { id: String(id), metadata: rest, vec, score };
  }

  /** The declared size of a pgvector column (dimensions, or bits for bit(n)). */
  private async typmod(table: string, column: string): Promise<number | null> {
    const d = await this.getPool().query(`SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = quote_ident($1)::regclass AND attname = $2`, [table, column]);
    return d.rows[0]?.dim > 0 ? Number(d.rows[0].dim) : null;
  }

  readonly searchableKinds: VectorKind[] = ['sparse', 'binary'];

  async describeCollection(name: string): Promise<ExplorerCollectionInfo> {
    const table = sanitizeSqlIdentifier(name, 'collectionOrTableName');
    const pool = this.getPool();
    const columns = await this.columnsOf(table);
    const extra = this.extraVectorColumns(columns);
    const embedding = columns.find((c) => c.name === 'embedding');
    const notes: string[] = [];
    let dimension: number | null = null;
    if (embedding?.type === 'vector') {
      // pgvector keeps the declared dimension as the column's type modifier.
      dimension = await this.typmod(table, 'embedding');
    } else {
      notes.push('No pgvector on this server: vectors are a plain array column and search scans every row.');
      const d = await pool.query(`SELECT array_length(embedding, 1) AS dim FROM "${table}" LIMIT 1`);
      dimension = d.rows[0]?.dim ?? null;
    }
    // Exact below a million rows; above that the planner's estimate, so a huge table never stalls the page.
    const est = await pool.query(`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = quote_ident($1)::regclass`, [table]);
    const estimate = Number(est.rows[0]?.n ?? -1);
    let recordCount: number;
    let countIsEstimate = false;
    if (estimate >= 1_000_000) {
      recordCount = estimate;
      countIsEstimate = true;
    } else {
      recordCount = Number((await pool.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
    }
    const idx = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexdef ~* 'using (hnsw|ivfflat)'`, [table]);
    const indexes = idx.rows.map((r: { indexdef: string }) => ({ type: normaliseIndexType(/using (\w+)/i.exec(r.indexdef)?.[1] ?? ''), detail: r.indexdef }));
    // The metric lives in the index's operator class; without an index, search uses cosine (<=>).
    const ops = idx.rows.map((r: { indexdef: string }) => /(vector_\w+_ops)/.exec(r.indexdef)?.[1]).find(Boolean);
    if (!indexes.length) notes.push('No ANN index: search is exact (a full scan) using cosine distance.');
    const metric = normaliseMetric(ops ?? null);
    const vectors = extra.length
      ? [
          { name: 'embedding', dimension, metric, kind: 'dense' as VectorKind },
          ...(await Promise.all(extra.map(async (c) => ({ name: c.name, dimension: await this.typmod(table, c.name), metric: c.kind === 'binary' ? 'hamming' : 'cosine', kind: c.kind })))),
        ]
      : undefined;
    if (vectors) notes.push(`Vector columns: ${vectors.map((v) => `${v.name} (${v.kind})`).join(', ')}. The figures above are for 'embedding'.`);
    return {
      name: table,
      recordCount,
      countIsEstimate,
      dimension,
      metric,
      indexes,
      fields: columns.filter((c) => !['id', 'embedding', 'created_at'].includes(c.name) && !extra.some((x) => x.name === c.name)),
      notes,
      ...(vectors ? { vectors } : {}),
    };
  }

  readonly supportsSort = true;

  async browse(name: string, options: BrowseOptions): Promise<ExplorerPage> {
    const table = sanitizeSqlIdentifier(name, 'collectionOrTableName');
    const typed = await this.columnsOf(table);
    const columns = typed.map((c) => c.name);
    const extra = this.extraVectorColumns(typed).map((c) => c.name);
    if (options.sort?.length) return this.browseSorted(table, columns, extra, options);
    const where = pgWhere(options.filter, columns, options.cursor === null ? 1 : 2);
    const conditions = [options.cursor === null ? null : `id::text > $1`, where.sql || null].filter(Boolean);
    const params = [...(options.cursor === null ? [] : [options.cursor]), ...where.params, options.limit + 1];
    const r = await this.getPool().query(
      `SELECT * FROM "${table}"${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id::text LIMIT $${params.length}`,
      params,
    );
    const rows = r.rows.slice(0, options.limit);
    return {
      records: rows.map((row) => {
        const { id, metadata, vec } = this.splitRow(row, extra, options.vectorName);
        return { id, metadata: trimMetadata(metadata), ...vectorFields(vec, options.withVectors) };
      }),
      nextCursor: r.rows.length > options.limit ? String(rows[rows.length - 1].id) : null,
    };
  }

  /** Sorted listings page by offset (the cursor is the offset); id breaks ties so pages never overlap. */
  private async browseSorted(table: string, columns: string[], extra: string[], options: BrowseOptions): Promise<ExplorerPage> {
    const sort = options.sort!;
    for (const s of sort) if (!columns.includes(s.field) || ['id', 'embedding', ...extra].includes(s.field)) throw new BadRequestException(`Cannot sort by '${s.field}'.`);
    const orderBy = sort.map((s) => `"${s.field}" ${s.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`).join(', ');
    const offset = options.cursor === null ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestException('Invalid page cursor.');
    const where = pgWhere(options.filter, columns, 1);
    const params = [...where.params, options.limit + 1, offset];
    const r = await this.getPool().query(
      `SELECT * FROM "${table}"${where.sql ? ` WHERE ${where.sql}` : ''} ORDER BY ${orderBy}, id::text LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const rows = r.rows.slice(0, options.limit);
    return {
      records: rows.map((row) => {
        const { id, metadata, vec } = this.splitRow(row, extra, options.vectorName);
        return { id, metadata: trimMetadata(metadata), ...vectorFields(vec, options.withVectors) };
      }),
      nextCursor: r.rows.length > options.limit ? String(offset + options.limit) : null,
    };
  }

  async searchFiltered(name: string, query: ExplorerVectorQuery): Promise<VectorSearchResult[]> {
    const table = sanitizeSqlIdentifier(name, 'collectionOrTableName');
    const typed = await this.columnsOf(table);
    const columns = typed.map((c) => c.name);
    const extras = this.extraVectorColumns(typed);
    if (query.vectorName && query.vectorName !== 'embedding') return this.searchColumn(table, typed, extras, query);
    if (!(await this.hasPgvector())) {
      const w = pgWhere(query.filter, columns, 1);
      const all = await this.getPool().query(`SELECT * FROM "${table}"${w.sql ? ` WHERE ${w.sql}` : ''}`, w.params);
      return all.rows
        .map((row) => {
          const { id, embedding, created_at, ...metadata } = row;
          return { id: String(id), score: this.cosineSimilarity(query.vector, embedding), metadata: trimMetadata(metadata) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, query.topK);
    }
    const where = pgWhere(query.filter, columns, 3);
    const clause = where.sql ? ` WHERE ${where.sql}` : '';
    const r = await this.getPool().query(
      `SELECT *, 1 - (embedding <=> $1) AS score FROM "${table}"${clause} ORDER BY embedding <=> $1 LIMIT $2`,
      [JSON.stringify(query.vector), query.topK, ...where.params],
    );
    return r.rows.map((row) => {
      const { id, metadata, score } = this.splitRow(row, extras.map((c) => c.name), undefined, true);
      return { id, score: Number(score), metadata: trimMetadata(metadata) };
    });
  }

  /**
   * Search another vector column: dense (vector / halfvec) and sparse
   * (sparsevec) by cosine, binary (bit) by Hamming distance, scored
   * 1 - distance / bits. Column names come from the table itself.
   */
  private async searchColumn(table: string, typed: Array<{ name: string; type: string }>, extras: Array<{ name: string; type: string; kind: VectorKind }>, query: ExplorerVectorQuery): Promise<VectorSearchResult[]> {
    const col = extras.find((c) => c.name === query.vectorName);
    if (!col) throw new BadRequestException(`Table '${table}' has no vector column '${query.vectorName}'.`);
    const size = await this.typmod(table, col.name);
    let literal: string;
    let distance: string;
    let score: string;
    if (col.kind === 'sparse') {
      if (!query.sparse) throw new BadRequestException(`'${col.name}' is a sparse vector column; search it with a sparse vector.`);
      const dim = size ?? Math.max(0, ...query.sparse.indices) + 1;
      if (query.sparse.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= dim)) throw new BadRequestException(`Sparse indices must be 0 to ${dim - 1}.`);
      // pgvector sparsevec text is 1-based.
      literal = `{${query.sparse.indices.map((i, k) => `${i + 1}:${query.sparse!.values[k]}`).join(',')}}/${dim}`;
      distance = `"${col.name}" <=> $1::sparsevec`;
      score = `1 - (${distance})`;
    } else if (col.kind === 'binary') {
      if (size !== null && query.vector.length !== size) throw new BadRequestException(`'${col.name}' holds ${size} bits; the query has ${query.vector.length}.`);
      literal = query.vector.map((b) => (b ? '1' : '0')).join('');
      distance = `"${col.name}" <~> $1::bit(${literal.length})`;
      score = `1 - (${distance})::float / ${literal.length}`;
    } else {
      literal = JSON.stringify(query.vector);
      distance = `"${col.name}" <=> $1::${col.type === 'halfvec' ? 'halfvec' : 'vector'}`;
      score = `1 - (${distance})`;
    }
    const where = pgWhere(query.filter, typed.map((c) => c.name), 3);
    const r = await this.getPool().query(
      `SELECT *, ${score} AS score FROM "${table}" WHERE "${col.name}" IS NOT NULL${where.sql ? ` AND ${where.sql}` : ''} ORDER BY ${distance} LIMIT $2`,
      [literal, query.topK, ...where.params],
    );
    return r.rows.map((row) => {
      const { id, metadata, score: s } = this.splitRow(row, extras.map((c) => c.name), undefined, true);
      return { id, score: Number(s), metadata: trimMetadata(metadata) };
    });
  }

  readonly keywordRanking = 'PostgreSQL full-text search (ts_rank, language-neutral "simple" dictionary) over the text columns';

  /**
   * Built-in full-text search over every text column - no extension or index
   * needed (without a GIN index it scans the table). The "simple" dictionary
   * matches whole words in any language, without stemming.
   */
  async keywordSearch(name: string, query: ExplorerKeywordQuery): Promise<VectorSearchResult[]> {
    const table = sanitizeSqlIdentifier(name, 'collectionOrTableName');
    const columns = await this.columnsOf(table);
    const text = columns.filter((c) => ['text', 'varchar', 'bpchar'].includes(c.type) && c.name !== 'id').map((c) => c.name);
    if (!text.length) throw new BadRequestException(`Table '${table}' has no text columns to search by keyword.`);
    const doc = `to_tsvector('simple', concat_ws(' ', ${text.map((c) => `"${c}"`).join(', ')}))`;
    const where = pgWhere(query.filter, columns.map((c) => c.name), 3);
    const r = await this.getPool().query(
      `SELECT *, ts_rank(${doc}, plainto_tsquery('simple', $1)) AS score FROM "${table}" WHERE ${doc} @@ plainto_tsquery('simple', $1)${where.sql ? ` AND ${where.sql}` : ''} ORDER BY score DESC, id LIMIT $2`,
      [query.text, query.topK, ...where.params],
    );
    const extra = this.extraVectorColumns(columns).map((c) => c.name);
    return r.rows.map((row) => {
      const { id, metadata, score } = this.splitRow(row, extra, undefined, true);
      return { id, score: Number(score), metadata: trimMetadata(metadata) };
    });
  }

  async getRecord(name: string, id: string, options: RecordReadOptions = {}): Promise<ExplorerRecordDetail | null> {
    const table = sanitizeSqlIdentifier(name, 'collectionOrTableName');
    const extras = this.extraVectorColumns(await this.columnsOf(table));
    const col = options.vectorName && options.vectorName !== 'embedding' ? extras.find((c) => c.name === options.vectorName) : undefined;
    if (options.vectorName && options.vectorName !== 'embedding' && !col) throw new BadRequestException(`Table '${table}' has no vector column '${options.vectorName}'.`);
    const r = await this.getPool().query(`SELECT * FROM "${table}" WHERE id::text = $1`, [id]);
    if (!r.rows[0]) return null;
    const { id: rid, metadata, vec } = this.splitRow(r.rows[0], extras.map((c) => c.name), col?.name);
    return recordDetail(rid, metadata, vec, col?.kind ?? 'dense');
  }
}
