import { BadGatewayException, BadRequestException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { ExplorerFilter, isExplorable, VectorExplorer } from '../database-adapters/vector-explorer';
import { VectorDatabaseAdapter } from '../database-adapters/vector-database-adapter.interface';
import { coerceFilter } from '../database-adapters/explorer-helpers';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { EmbeddingClientService } from '../embedding-client/embedding-client.service';
import { compareDesign, DesignedCollection } from './data-explorer.compare';
import { ExplorerMapQueryDto, ExplorerSearchDto } from './dto/explorer-search.dto';
import { project } from './projection';

export const CALL_TIMEOUT_MS = 10_000;
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 25;
export const MAX_FILTER_FIELDS = 5;
export const DEFAULT_MAP_SAMPLE = 500;
export const MAX_MAP_SAMPLE = 1000;
/**
 * Colour groups on the map: the most common values, then "Other". Three, because
 * on a scatter every pair of colours must stay distinguishable (including for
 * colour-blind readers); only three hues pass that in both themes.
 */
export const MAP_GROUPS = 3;
const UNSUPPORTED = 'The Data Explorer does not support this platform (Actian has no Node.js driver).';

/**
 * Data Explorer (phase 1): read-only look inside the project's target vector
 * database - collections, records, search - compared against the project's
 * own design. Never writes, loads or changes anything on the target.
 */
@Injectable()
export class DataExplorerService {
  private readonly logger = new Logger(DataExplorerService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly adapters: VectorAdapterFactory,
    private readonly pipelines: DataPipelineDesignService,
    private readonly indexDesigns: IndexDesignService,
    private readonly discovery: DiscoveryService,
    private readonly embeddings: EmbeddingClientService,
  ) {}

  /** Runs one call against the target with a time limit; driver errors become readable, credential-free messages. */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ServiceUnavailableException(`The target database did not answer within ${CALL_TIMEOUT_MS / 1000} s (${what}).`)), CALL_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const raw = (e as Error)?.message ?? String(e);
      this.logger.warn(`Data Explorer ${what} failed: ${raw}`);
      // Never echo a connection string or credentials back.
      const safe = raw.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]*@[^\s]*/gi, '[connection]').slice(0, 300);
      throw new BadGatewayException(`The target database returned an error (${what}): ${safe}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async target(projectId: string, requester: AuthenticatedUser): Promise<{ platform: VectorPlatform; adapter: VectorDatabaseAdapter & VectorExplorer }> {
    const project = await this.projectsService.findOne(projectId, requester);
    if (project.platform === VectorPlatform.UNDETERMINED) throw new BadRequestException('This project has no target platform yet. Complete Vector DB Selection first.');
    const adapter = this.adapters.getAdapter(project.platform);
    if (!isExplorable(adapter)) throw new BadRequestException(UNSUPPORTED);
    return { platform: project.platform, adapter };
  }

  /** The collection must be one the database itself lists - names from the request never reach a query unchecked. */
  private async collection(adapter: VectorExplorer, name: string): Promise<void> {
    const names = await this.call('list collections', () => adapter.listCollections());
    if (!names.includes(name)) throw new NotFoundException(`The target database has no collection '${name}'.`);
  }

  /** What the design's collection is called in this database. */
  private designedName(adapter: VectorExplorer, name: string): string {
    return adapter.designedName ? adapter.designedName(name) : name;
  }

  private async design(projectId: string, requester: AuthenticatedUser, adapter?: VectorExplorer): Promise<DesignedCollection> {
    const [pipeline, index, discovery] = await Promise.all([
      this.pipelines.getLatest(projectId, requester),
      this.indexDesigns.getLatest(projectId, requester),
      this.discovery.getLatest(projectId, requester),
    ]);
    return {
      pipeline: pipeline
        ? { version: pipeline.version, collectionName: adapter ? this.designedName(adapter, pipeline.collectionName) : pipeline.collectionName, dimension: pipeline.embeddingDimension, metric: pipeline.similarityMetric, metadataFields: pipeline.metadataFields.map((f) => f.name) }
        : null,
      index: index ? { version: index.version, type: index.decision } : null,
      discovery: discovery ? { version: discovery.assessment.version, estimatedVectorCount: discovery.assessment.estimatedVectorCount } : null,
    };
  }

  /** What the tab can do for this project, without failing when it can do nothing. */
  async status(projectId: string, requester: AuthenticatedUser) {
    const project = await this.projectsService.findOne(projectId, requester);
    const pipeline = await this.pipelines.getLatest(projectId, requester);
    const base = { platform: project.platform, designedCollection: pipeline?.collectionName ?? null };
    if (project.platform !== VectorPlatform.UNDETERMINED && pipeline) {
      const a = this.adapters.getAdapter(project.platform);
      if (isExplorable(a)) base.designedCollection = this.designedName(a, pipeline.collectionName);
    }
    if (project.platform === VectorPlatform.UNDETERMINED) return { ...base, supported: false, connected: false, message: 'No target platform yet. Complete Vector DB Selection first.' };
    const adapter = this.adapters.getAdapter(project.platform);
    if (!isExplorable(adapter)) return { ...base, supported: false, connected: false, message: UNSUPPORTED };
    try {
      const connected = await this.call('health check', () => adapter.healthCheck());
      return { ...base, supported: true, connected, message: connected ? null : 'The target database did not answer the health check. Check its TARGET_* settings on the server.' };
    } catch (e) {
      return { ...base, supported: true, connected: false, message: (e as Error).message };
    }
  }

  async collections(projectId: string, requester: AuthenticatedUser) {
    const { adapter } = await this.target(projectId, requester);
    const [names, pipeline] = await Promise.all([this.call('list collections', () => adapter.listCollections()), this.pipelines.getLatest(projectId, requester)]);
    const designed = pipeline ? this.designedName(adapter, pipeline.collectionName) : null;
    return { designedCollection: designed, collections: names.map((name) => ({ name, designed: name === designed })) };
  }

  async overview(projectId: string, requester: AuthenticatedUser, name: string) {
    const { platform, adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const [info, design] = await Promise.all([this.call('describe collection', () => adapter.describeCollection(name)), this.design(projectId, requester, adapter)]);
    return { platform, info, checks: compareDesign(name, info, design) };
  }

  /** Validates the filter shape, then converts each value to its field's type (unknown fields are refused). */
  private async filterFor(adapter: VectorExplorer, name: string, raw: unknown): Promise<ExplorerFilter> {
    if (raw === undefined || raw === null || (typeof raw === 'object' && !Object.keys(raw as object).length)) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('filter must be an object of field → value.');
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_FILTER_FIELDS) throw new BadRequestException(`At most ${MAX_FILTER_FIELDS} filter fields.`);
    for (const [k, v] of entries) {
      if (!['string', 'number', 'boolean'].includes(typeof v)) throw new BadRequestException(`Filter value for '${k}' must be text, a number or true / false.`);
      if (String(v).length > 200) throw new BadRequestException(`Filter value for '${k}' is too long.`);
    }
    const info = await this.call('describe collection', () => adapter.describeCollection(name));
    return coerceFilter(raw as ExplorerFilter, info.fields);
  }

  parseFilterParam(filter: string | undefined): unknown {
    if (!filter) return undefined;
    try {
      return JSON.parse(filter);
    } catch {
      throw new BadRequestException('filter must be JSON, e.g. {"department":"legal"}.');
    }
  }

  async documents(projectId: string, requester: AuthenticatedUser, name: string, q: { limit?: number; cursor?: string; filter?: string }) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const filter = await this.filterFor(adapter, name, this.parseFilterParam(q.filter));
    const limit = Math.min(MAX_PAGE, Math.max(1, q.limit ?? DEFAULT_PAGE));
    const page = await this.call('browse', () => adapter.browse(name, { limit, cursor: q.cursor ?? null, filter }));
    return { collection: name, limit, filter, rows: page.records, nextCursor: page.nextCursor };
  }

  /**
   * The embedding map: a sample of the collection's vectors projected to 2D on
   * the server. Only ids, positions and the colour-by value leave the server -
   * never the vectors or other metadata.
   */
  async map(projectId: string, requester: AuthenticatedUser, name: string, q: ExplorerMapQueryDto) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const info = await this.call('describe collection', () => adapter.describeCollection(name));
    if (q.colorBy && !info.fields.some((f) => f.name === q.colorBy)) throw new BadRequestException(`The collection has no field '${q.colorBy}'.`);
    const filter = await this.filterFor(adapter, name, this.parseFilterParam(q.filter));
    const sample = Math.min(MAX_MAP_SAMPLE, Math.max(10, q.sample ?? DEFAULT_MAP_SAMPLE));
    const method = q.method ?? 'pca';

    // The first records in the database's own order, 100 at a time.
    const rows: Array<{ id: string; vector: number[]; group: string | null }> = [];
    let cursor: string | null = null;
    let dimension: number | null = null;
    let skipped = 0;
    do {
      const page = await this.call('read vectors', () => adapter.browse(name, { limit: Math.min(100, sample - rows.length), cursor, filter, withVectors: true }));
      for (const r of page.records) {
        if (!r.vector?.length) {
          skipped++;
          continue;
        }
        dimension ??= r.vector.length;
        if (r.vector.length !== dimension) {
          skipped++;
          continue;
        }
        const v = q.colorBy ? r.metadata[q.colorBy] : undefined;
        rows.push({ id: r.id, vector: r.vector, group: q.colorBy ? (v === null || v === undefined ? null : String(v).slice(0, 80)) : null });
      }
      cursor = page.nextCursor;
    } while (cursor && rows.length < sample);

    if (rows.length < 3) {
      return { collection: name, method, requested: sample, sampled: rows.length, dimension, colorBy: q.colorBy ?? null, groups: [], points: [], explainedVariance: null, notes: [skipped ? `${skipped} record(s) came back without a vector.` : 'Too few records with vectors to draw a map (at least 3).'] };
    }
    const started = Date.now();
    const projection = project(rows.map((r) => r.vector), method);

    // Colour groups: the most common values; the rest become "Other".
    const counts = new Map<string, number>();
    for (const r of rows) if (r.group !== null) counts.set(r.group, (counts.get(r.group) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAP_GROUPS).map(([v]) => v);
    const groupOf = (g: string | null) => (g === null ? '(none)' : top.includes(g) ? g : 'Other');
    const groups = q.colorBy ? [...top, 'Other', '(none)'].map((value) => ({ value, count: rows.filter((r) => groupOf(r.group) === value).length })).filter((g) => g.count > 0) : [];

    return {
      collection: name,
      method,
      requested: sample,
      sampled: rows.length,
      dimension,
      colorBy: q.colorBy ?? null,
      groups,
      points: rows.map((r, i) => ({ id: r.id, x: projection.points[i][0], y: projection.points[i][1], group: q.colorBy ? groupOf(r.group) : null })),
      explainedVariance: projection.explainedVariance,
      notes: [
        `The first ${rows.length.toLocaleString('en-US')} records in the database's own order${Object.keys(filter).length ? ' matching the filter' : ''} - a sample, not the whole collection.`,
        method === 'umap'
          ? 'UMAP keeps neighbourhoods: close points are similar, but distances between clusters and cluster sizes carry no meaning.'
          : 'PCA keeps the two directions of greatest variance; points far apart on an axis differ most along it.',
        skipped ? `${skipped} record(s) without a usable vector were left out.` : null,
        `Projected in ${Date.now() - started} ms on the server; the vectors themselves never leave it.`,
      ].filter(Boolean),
    };
  }

  async search(projectId: string, requester: AuthenticatedUser, name: string, dto: ExplorerSearchDto) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    if (!!dto.text === !!dto.vector) throw new BadRequestException('Give either text (embedded with the project’s embedding model) or a vector, not both.');
    const [info, pipeline, discovery] = await Promise.all([
      this.call('describe collection', () => adapter.describeCollection(name)),
      this.pipelines.getLatest(projectId, requester),
      this.discovery.getLatest(projectId, requester),
    ]);
    let vector = dto.vector ?? null;
    let embedding: { providerId: string; modelId: string; live: boolean } | null = null;
    if (dto.text) {
      if (!pipeline) throw new BadRequestException('Text search embeds the query with the project’s embedding model; complete Data & Embedding design first, or search with a vector.');
      // Embedded exactly as ingestion embeds documents, so query and records share one vector space.
      const e = await this.embeddings.embed({ providerId: pipeline.embeddingProviderId, modelId: pipeline.embeddingModelId, dimension: pipeline.embeddingDimension, text: dto.text });
      vector = e.vector;
      embedding = { providerId: pipeline.embeddingProviderId, modelId: pipeline.embeddingModelId, live: e.isLiveProvider };
    }
    if (info.dimension !== null && vector!.length !== info.dimension) {
      throw new BadRequestException(`The query vector has ${vector!.length} dimensions; the collection holds ${info.dimension}.`);
    }
    const filter = await this.filterFor(adapter, name, dto.filter);
    const topK = dto.topK ?? 10;
    const started = process.hrtime.bigint();
    const results = await this.call('search', () => adapter.searchFiltered(name, { vector: vector!, topK, filter }));
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    const target = discovery?.assessment.targetP95LatencyMs ?? null;
    return {
      collection: name,
      topK,
      filter,
      results,
      latencyMs,
      targetP95LatencyMs: target,
      withinTarget: target === null ? null : latencyMs <= target,
      embedding,
      notes: [
        'One query, timed from this server including the network - an indication, not a P95; the Performance phase measures percentiles.',
        embedding && !embedding.live ? 'The embedding provider was not reachable, so the query used the offline stand-in embedding. Results are only meaningful if the records were ingested the same way.' : null,
      ].filter(Boolean),
    };
  }
}
