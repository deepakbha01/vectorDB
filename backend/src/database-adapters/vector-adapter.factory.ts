import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { VectorDatabaseAdapter } from './vector-database-adapter.interface';
import { OracleVectorAdapter } from './oracle/oracle-vector.adapter';
import { PostgresVectorAdapter } from './postgres/postgres-vector.adapter';
import { MilvusVectorAdapter } from './milvus/milvus-vector.adapter';
import { PineconeVectorAdapter } from './pinecone/pinecone-vector.adapter';
import { QdrantVectorAdapter } from './qdrant/qdrant-vector.adapter';
import { WeaviateVectorAdapter } from './weaviate/weaviate-vector.adapter';
import { ChromaVectorAdapter } from './chroma/chroma-vector.adapter';
import { ElasticsearchVectorAdapter } from './elasticsearch/elasticsearch-vector.adapter';
import { RedisVectorAdapter } from './redis/redis-vector.adapter';
import { MongoDbAtlasVectorAdapter } from './mongodb/mongodb-atlas-vector.adapter';
import { LanceDbVectorAdapter } from './lancedb/lancedb-vector.adapter';
import { ActianVectorAdapter } from './actian/actian-vector.adapter';
import { SchemaGeneratorService } from '../schema-generator/schema-generator.service';
import { ProjectConnectionProfile } from './connection/project-connection-profile.entity';
import { parseSecretKey, unseal } from './connection/secret-box';

/** Where a project's target connection comes from. */
export type ConnectionSource = 'project' | 'server';

/**
 * Single point where a project's resolved platform is mapped to a concrete adapter.
 * Ingestion/Operations engines (Phase 5-7) depend only on this factory, never on a
 * concrete adapter class directly.
 *
 * forProject() applies a project's own connection profile when it has one: a
 * separate adapter instance reading only the profile's settings (never the
 * server's TARGET_* values), cached until the profile changes.
 */
@Injectable()
export class VectorAdapterFactory implements OnModuleDestroy {
  private readonly perProject = new Map<string, { stamp: string; adapter: VectorDatabaseAdapter }>();

  constructor(
    private readonly oracle: OracleVectorAdapter,
    private readonly postgres: PostgresVectorAdapter,
    private readonly milvus: MilvusVectorAdapter,
    private readonly pinecone: PineconeVectorAdapter,
    private readonly qdrant: QdrantVectorAdapter,
    private readonly weaviate: WeaviateVectorAdapter,
    private readonly chroma: ChromaVectorAdapter,
    private readonly elasticsearch: ElasticsearchVectorAdapter,
    private readonly redis: RedisVectorAdapter,
    private readonly mongodbAtlas: MongoDbAtlasVectorAdapter,
    private readonly lancedb: LanceDbVectorAdapter,
    private readonly actian: ActianVectorAdapter,
    private readonly schemaGenerator: SchemaGeneratorService,
    private readonly config: ConfigService,
    @InjectRepository(ProjectConnectionProfile) private readonly profiles: Repository<ProjectConnectionProfile>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.perProject.values()].map((c) => this.dispose(c.adapter)));
    this.perProject.clear();
  }

  private async dispose(adapter: VectorDatabaseAdapter): Promise<void> {
    try {
      await (adapter as Partial<OnModuleDestroy>).onModuleDestroy?.();
    } catch {
      // A connection that will not close cleanly is dropped anyway.
    }
  }

  /** CONNECTION_SECRET_KEY, or null when the server cannot store connection profiles. */
  secretKey(): Buffer | null {
    return parseSecretKey(this.config.get<string>('CONNECTION_SECRET_KEY'));
  }

  /** A new adapter for `platform` that reads its connection only from `settings`. */
  buildWith(platform: VectorPlatform, settings: Record<string, string>): VectorDatabaseAdapter {
    const cfg = { get: (key: string, fallback?: unknown) => (settings[key] !== undefined && settings[key] !== '' ? settings[key] : fallback) } as unknown as ConfigService;
    const g = this.schemaGenerator;
    switch (platform) {
      case VectorPlatform.ORACLE:
        return new OracleVectorAdapter(cfg, g);
      case VectorPlatform.POSTGRES_PGVECTOR:
        return new PostgresVectorAdapter(cfg, g);
      case VectorPlatform.MILVUS:
        return new MilvusVectorAdapter(cfg, g);
      case VectorPlatform.PINECONE:
        return new PineconeVectorAdapter(cfg);
      case VectorPlatform.QDRANT:
        return new QdrantVectorAdapter(cfg, g);
      case VectorPlatform.WEAVIATE:
        return new WeaviateVectorAdapter(cfg, g);
      case VectorPlatform.CHROMA:
        return new ChromaVectorAdapter(cfg);
      case VectorPlatform.ELASTICSEARCH:
        return new ElasticsearchVectorAdapter(cfg, g);
      case VectorPlatform.REDIS:
        return new RedisVectorAdapter(cfg);
      case VectorPlatform.MONGODB_ATLAS:
        return new MongoDbAtlasVectorAdapter(cfg, g);
      case VectorPlatform.LANCEDB:
        return new LanceDbVectorAdapter(cfg);
      default:
        return this.getAdapter(platform);
    }
  }

  /** The project's own profile for its current platform, if any (settings still sealed). */
  async profileFor(project: { id: string; platform: VectorPlatform }): Promise<ProjectConnectionProfile | null> {
    const p = await this.profiles.findOne({ where: { project: { id: project.id } } });
    return p && p.platform === project.platform ? p : null;
  }

  /** Where this project's connection comes from. */
  async sourceFor(project: { id: string; platform: VectorPlatform }): Promise<ConnectionSource> {
    return (await this.profileFor(project)) ? 'project' : 'server';
  }

  /**
   * The adapter for a project: its own connection profile when it has one,
   * else the server-wide adapter. A profile the server cannot open is an
   * error - never a silent fall-back to the server's credentials.
   */
  async forProject(project: { id: string; platform: VectorPlatform }): Promise<VectorDatabaseAdapter> {
    const profile = await this.profileFor(project);
    if (!profile) {
      const stale = this.perProject.get(project.id);
      if (stale) {
        this.perProject.delete(project.id);
        await this.dispose(stale.adapter);
      }
      return this.getAdapter(project.platform);
    }
    const stamp = `${profile.platform}@${profile.updatedAt.toISOString()}`;
    const cached = this.perProject.get(project.id);
    if (cached?.stamp === stamp) return cached.adapter;
    const key = this.secretKey();
    if (!key) throw new BadRequestException('This project has its own connection, but the server has no valid CONNECTION_SECRET_KEY to open it.');
    let settings: Record<string, string>;
    try {
      settings = JSON.parse(unseal(profile.settingsSealed, key)) as Record<string, string>;
    } catch {
      throw new BadRequestException("This project's connection cannot be opened with the server's CONNECTION_SECRET_KEY (was the key changed?). Save the connection again.");
    }
    if (cached) await this.dispose(cached.adapter);
    const adapter = this.buildWith(project.platform, settings);
    this.perProject.set(project.id, { stamp, adapter });
    return adapter;
  }

  getAdapter(platform: VectorPlatform): VectorDatabaseAdapter {
    switch (platform) {
      case VectorPlatform.ORACLE:
        return this.oracle;
      case VectorPlatform.POSTGRES_PGVECTOR:
        return this.postgres;
      case VectorPlatform.MILVUS:
        return this.milvus;
      case VectorPlatform.PINECONE:
        return this.pinecone;
      case VectorPlatform.QDRANT:
        return this.qdrant;
      case VectorPlatform.WEAVIATE:
        return this.weaviate;
      case VectorPlatform.CHROMA:
        return this.chroma;
      case VectorPlatform.ELASTICSEARCH:
        return this.elasticsearch;
      case VectorPlatform.REDIS:
        return this.redis;
      case VectorPlatform.MONGODB_ATLAS:
        return this.mongodbAtlas;
      case VectorPlatform.LANCEDB:
        return this.lancedb;
      case VectorPlatform.ACTIAN:
        return this.actian;
      default:
        throw new Error(
          `Cannot resolve a database adapter: platform is '${platform}'. Complete Phase 4 Vector DB Selection (or manually select a platform) first.`,
        );
    }
  }
}
