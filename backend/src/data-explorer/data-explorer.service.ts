import { BadGatewayException, BadRequestException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { ConnectionSource, VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { ExplorerCollectionInfo, ExplorerFilter, ExplorerSort, fuseResults, fuseWeighted, isExplorable, MAX_SORT_FIELDS, NO_FILTER, SparseVector, VectorExplorer, VectorKind } from '../database-adapters/vector-explorer';
import { VectorDatabaseAdapter } from '../database-adapters/vector-database-adapter.interface';
import { checkPartition, coerceFilter, parseFilterInput } from '../database-adapters/explorer-helpers';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { EmbeddingClientService } from '../embedding-client/embedding-client.service';
import { compareDesign, DesignedCollection, KeywordSupport } from './data-explorer.compare';
import { ExplorerCompareDto, ExplorerMapQueryDto, ExplorerSearchDto } from './dto/explorer-search.dto';
import { compareResults, queryStats, scoreStats } from './search-stats';
import { project } from './projection';

export const CALL_TIMEOUT_MS = 10_000;
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 25;
export const MAX_FILTER_FIELDS = 5;
/** Candidates each side of a hybrid search, before fusion. */
export const HYBRID_CANDIDATES_PER_RESULT = 4;
export const MAX_HYBRID_CANDIDATES = 200;
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
    const adapter = await this.adapters.forProject(project);
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
      discovery: discovery ? { version: discovery.assessment.version, estimatedVectorCount: discovery.assessment.estimatedVectorCount, requiresHybridSearch: discovery.assessment.requiresHybridSearch } : null,
    };
  }

  /**
   * A named vector the collection really has (names from the request never
   * reach the database unchecked), and the dimension and metric of the space
   * used - the chosen one, else the collection's first.
   */
  private vectorSpace(info: ExplorerCollectionInfo, requested: string | undefined): { vectorName: string | undefined; dimension: number | null; kind: VectorKind } {
    if (!requested) return { vectorName: undefined, dimension: info.dimension, kind: 'dense' };
    const space = info.vectors?.find((v) => v.name === requested);
    if (!space) throw new BadRequestException(info.vectors?.length ? `The collection has no vector '${requested}' (it has ${info.vectors.map((v) => v.name).join(', ')}).` : 'This collection has a single vector; there is no vector to choose.');
    return { vectorName: space.name, dimension: space.dimension, kind: space.kind ?? 'dense' };
  }

  /** The collection described for one tenant / namespace (where it has them), and that partition checked. */
  private async describePartition(adapter: VectorExplorer, name: string, requested: string | undefined): Promise<{ info: ExplorerCollectionInfo; partition: string | undefined }> {
    const info = await this.call('describe collection', () => adapter.describeCollection(name, requested));
    return { info, partition: checkPartition(info.partitions, requested) };
  }

  private keywordSupport(adapter: VectorExplorer): KeywordSupport {
    return { supported: typeof adapter.keywordSearch === 'function', ranking: adapter.keywordRanking ?? null };
  }

  /** What the tab can do for this project, without failing when it can do nothing. */
  async status(projectId: string, requester: AuthenticatedUser) {
    const project = await this.projectsService.findOne(projectId, requester);
    const pipeline = await this.pipelines.getLatest(projectId, requester);
    const base = { platform: project.platform, designedCollection: pipeline?.collectionName ?? null, connectionSource: 'server' as ConnectionSource };
    if (project.platform === VectorPlatform.UNDETERMINED) return { ...base, supported: false, connected: false, message: 'No target platform yet. Complete Vector DB Selection first.' };
    base.connectionSource = await this.adapters.sourceFor(project);
    let adapter: VectorDatabaseAdapter;
    try {
      adapter = await this.adapters.forProject(project);
    } catch (e) {
      return { ...base, supported: true, connected: false, message: (e as Error).message };
    }
    if (!isExplorable(adapter)) return { ...base, supported: false, connected: false, message: UNSUPPORTED };
    if (pipeline) base.designedCollection = this.designedName(adapter, pipeline.collectionName);
    const where = base.connectionSource === 'project' ? "this project's connection settings" : 'the TARGET_* settings on the server';
    try {
      const connected = await this.call('health check', () => adapter.healthCheck());
      return { ...base, supported: true, connected, message: connected ? null : `The target database did not answer the health check. Check ${where}.` };
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

  async overview(projectId: string, requester: AuthenticatedUser, name: string, partition?: string) {
    const { platform, adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const [info, design] = await Promise.all([this.call('describe collection', () => adapter.describeCollection(name, partition)), this.design(projectId, requester, adapter)]);
    if (partition) checkPartition(info.partitions, partition);
    const keyword = this.keywordSupport(adapter);
    return {
      platform,
      info,
      capabilities: {
        keyword,
        sort: !!adapter.supportsSort,
        nativeHybrid: { supported: typeof adapter.nativeHybrid === 'function', ranking: adapter.nativeHybridRanking ?? null },
        searchableKinds: ['dense', ...(adapter.searchableKinds ?? [])] as VectorKind[],
      },
      checks: compareDesign(name, info, design, keyword),
    };
  }

  /**
   * Accepts `{ field: value }` (all equal) or `{ combine, conditions: [{ field, op, value }] }`;
   * checks each field and operator against the collection and converts values to the field's type.
   */
  private async filterFor(adapter: VectorExplorer, name: string, raw: unknown): Promise<ExplorerFilter> {
    const parsed = parseFilterInput(raw);
    if (!parsed.conditions.length) return NO_FILTER;
    if (parsed.conditions.length > MAX_FILTER_FIELDS) throw new BadRequestException(`At most ${MAX_FILTER_FIELDS} filter conditions.`);
    const info = await this.call('describe collection', () => adapter.describeCollection(name));
    return coerceFilter(parsed, info.fields);
  }

  parseFilterParam(filter: string | undefined): unknown {
    if (!filter) return undefined;
    try {
      return JSON.parse(filter);
    } catch {
      throw new BadRequestException('filter must be JSON, e.g. {"department":"legal"}.');
    }
  }

  /** "year:desc,dept" -> [{year, desc}, {dept, asc}]; sortBy/sortDir is the one-field form. */
  private parseSort(q: { sort?: string; sortBy?: string; sortDir?: 'asc' | 'desc' }): ExplorerSort[] {
    if (!q.sort) return q.sortBy ? [{ field: q.sortBy, direction: q.sortDir ?? 'asc' }] : [];
    const parts = q.sort.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > MAX_SORT_FIELDS) throw new BadRequestException(`Sort by at most ${MAX_SORT_FIELDS} fields.`);
    const sort = parts.map((p) => {
      const i = p.lastIndexOf(':');
      const field = (i > 0 ? p.slice(0, i) : p).trim();
      const direction = (i > 0 ? p.slice(i + 1) : 'asc').trim().toLowerCase();
      if (!field || (direction !== 'asc' && direction !== 'desc')) throw new BadRequestException(`Invalid sort '${p}': use field or field:asc / field:desc.`);
      return { field, direction: direction as 'asc' | 'desc' };
    });
    if (new Set(sort.map((s) => s.field)).size !== sort.length) throw new BadRequestException('Each field can be sorted by once.');
    return sort;
  }

  async documents(projectId: string, requester: AuthenticatedUser, name: string, q: { limit?: number; cursor?: string; filter?: string; sort?: string; sortBy?: string; sortDir?: 'asc' | 'desc'; partition?: string }) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const { partition } = await this.describePartition(adapter, name, q.partition);
    const filter = await this.filterFor(adapter, name, this.parseFilterParam(q.filter));
    const limit = Math.min(MAX_PAGE, Math.max(1, q.limit ?? DEFAULT_PAGE));
    const sort = this.parseSort(q);
    if (sort.length) {
      if (!adapter.supportsSort) throw new BadRequestException('This database cannot order a record listing; sorting is not available here.');
      const info = await this.call('describe collection', () => adapter.describeCollection(name));
      for (const s of sort) if (!info.fields.some((f) => f.name === s.field)) throw new BadRequestException(`The collection has no field '${s.field}'.`);
    }
    const page = await this.call('browse', () => adapter.browse(name, { limit, cursor: q.cursor ?? null, filter, ...(sort.length ? { sort } : {}), ...(partition ? { partition } : {}) }));
    return { collection: name, partition: partition ?? null, limit, filter, sort: sort.length ? sort : null, rows: page.records, nextCursor: page.nextCursor };
  }

  /**
   * The embedding map: a sample of the collection's vectors projected to 2D on
   * the server. Only ids, positions and the colour-by value leave the server -
   * never the vectors or other metadata.
   */
  async map(projectId: string, requester: AuthenticatedUser, name: string, q: ExplorerMapQueryDto) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const { info, partition } = await this.describePartition(adapter, name, q.partition);
    if (q.colorBy && !info.fields.some((f) => f.name === q.colorBy)) throw new BadRequestException(`The collection has no field '${q.colorBy}'.`);
    const filter = await this.filterFor(adapter, name, this.parseFilterParam(q.filter));
    const sample = Math.min(MAX_MAP_SAMPLE, Math.max(10, q.sample ?? DEFAULT_MAP_SAMPLE));
    const method = q.method ?? 'pca';
    const dims = q.dims === 3 ? 3 : 2;
    const { vectorName, kind } = this.vectorSpace(info, q.vectorName);
    if (kind !== 'dense') throw new BadRequestException(`The map projects dense vectors; '${vectorName}' is ${kind}.`);

    // The first records in the database's own order, 100 at a time.
    const rows: Array<{ id: string; vector: number[]; group: string | null }> = [];
    let cursor: string | null = null;
    let dimension: number | null = null;
    let skipped = 0;
    do {
      const page = await this.call('read vectors', () => adapter.browse(name, { limit: Math.min(100, sample - rows.length), cursor, filter, withVectors: true, vectorName, ...(partition ? { partition } : {}) }));
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
      return { collection: name, method, dims, vectorName: vectorName ?? null, requested: sample, sampled: rows.length, dimension, colorBy: q.colorBy ?? null, groups: [], points: [], explainedVariance: null, notes: [skipped ? `${skipped} record(s) came back without a vector.` : 'Too few records with vectors to draw a map (at least 3).'] };
    }
    const started = Date.now();
    const projection = project(rows.map((r) => r.vector), method, dims);

    // Colour groups: the most common values; the rest become "Other".
    const counts = new Map<string, number>();
    for (const r of rows) if (r.group !== null) counts.set(r.group, (counts.get(r.group) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAP_GROUPS).map(([v]) => v);
    const groupOf = (g: string | null) => (g === null ? '(none)' : top.includes(g) ? g : 'Other');
    const groups = q.colorBy ? [...top, 'Other', '(none)'].map((value) => ({ value, count: rows.filter((r) => groupOf(r.group) === value).length })).filter((g) => g.count > 0) : [];

    return {
      collection: name,
      method,
      dims,
      vectorName: vectorName ?? null,
      requested: sample,
      sampled: rows.length,
      dimension,
      colorBy: q.colorBy ?? null,
      groups,
      points: rows.map((r, i) => ({ id: r.id, x: projection.points[i][0], y: projection.points[i][1], ...(dims === 3 ? { z: projection.points[i][2] } : {}), group: q.colorBy ? groupOf(r.group) : null })),
      explainedVariance: projection.explainedVariance,
      notes: [
        `The first ${rows.length.toLocaleString('en-US')} records in the database's own order${filter.conditions.length ? ' matching the filter' : ''} - a sample, not the whole collection.`,
        method === 'umap'
          ? 'UMAP keeps neighbourhoods: close points are similar, but distances between clusters and cluster sizes carry no meaning.'
          : method === 'tsne'
            ? 't-SNE keeps close neighbours closest of all and separates clusters sharply, but the distances between clusters, their sizes and the overall layout carry no meaning.'
            : `PCA keeps the ${dims === 3 ? 'three' : 'two'} directions of greatest variance; points far apart on an axis differ most along it.`,
        vectorName ? `Vector '${vectorName}'.` : null,
        skipped ? `${skipped} record(s) without a usable vector were left out.` : null,
        `Projected in ${Date.now() - started} ms on the server; the vectors themselves never leave it.`,
      ].filter(Boolean),
    };
  }

  /** One record in full - every field (up to 20,000 characters each) and the head of its vector. */
  async record(projectId: string, requester: AuthenticatedUser, name: string, id: string, requestedVector?: string, requestedPartition?: string) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    if (!adapter.getRecord) throw new BadRequestException('This database cannot fetch a single record here.');
    if (!id || id.length > 500) throw new BadRequestException('Invalid record id.');
    let vectorName: string | undefined;
    let partition: string | undefined;
    if (requestedVector || requestedPartition) {
      const d = await this.describePartition(adapter, name, requestedPartition);
      partition = d.partition;
      vectorName = this.vectorSpace(d.info, requestedVector).vectorName;
    }
    const r = await this.call('read record', () => adapter.getRecord!(name, id, { vectorName, partition }));
    if (!r) throw new NotFoundException(`No record '${id}' in '${name}'.`);
    return { collection: name, vectorName: vectorName ?? null, partition: partition ?? null, ...r };
  }

  /**
   * The same query run two ways (e.g. dense vs hybrid, two weightings, with and
   * without a filter), one after the other so each is timed on its own; plus
   * how much the two result lists overlap and which records moved.
   */
  async compare(projectId: string, requester: AuthenticatedUser, name: string, dto: ExplorerCompareDto) {
    const side = (s: ExplorerCompareDto['a']) => ({ text: dto.text, vector: dto.vector, sparse: dto.sparse, partition: dto.partition, mode: s.mode, alpha: s.alpha, topK: s.topK, filter: s.filter, vectorName: s.vectorName, fusion: s.fusion, minScore: s.minScore }) as ExplorerSearchDto;
    const a = await this.search(projectId, requester, name, side(dto.a));
    const b = await this.search(projectId, requester, name, side(dto.b));
    return { collection: name, a, b, overlap: compareResults(a.results, b.results) };
  }

  async search(projectId: string, requester: AuthenticatedUser, name: string, dto: ExplorerSearchDto) {
    const { adapter } = await this.target(projectId, requester);
    await this.collection(adapter, name);
    const mode = dto.mode ?? 'dense';
    const [{ info, partition }, pipeline, discovery] = await Promise.all([
      this.describePartition(adapter, name, dto.partition),
      this.pipelines.getLatest(projectId, requester),
      this.discovery.getLatest(projectId, requester),
    ]);
    const { vectorName, dimension, kind } = this.vectorSpace(info, dto.vectorName);

    // What the query is: text, a dense vector, bits for a binary space, or a sparse vector.
    let sparse: SparseVector | undefined;
    if (kind !== 'dense') {
      if (mode !== 'dense') throw new BadRequestException(`'${vectorName}' is a ${kind} vector; keyword and hybrid search use the dense vector.`);
      if (!(adapter.searchableKinds ?? []).includes(kind)) throw new BadRequestException(`This database cannot search ${kind} vectors here.`);
      if (dto.text) throw new BadRequestException(`'${vectorName}' is a ${kind} vector; text is embedded as a dense vector, so give the query as a ${kind} vector.`);
    }
    if (kind === 'sparse') {
      if (!dto.sparse || dto.vector) throw new BadRequestException(`'${vectorName}' is a sparse vector; give the query as { indices, values }.`);
      if (dto.sparse.indices.length !== dto.sparse.values.length) throw new BadRequestException('A sparse vector needs as many values as indices.');
      if (new Set(dto.sparse.indices).size !== dto.sparse.indices.length) throw new BadRequestException('A sparse vector cannot repeat an index.');
      sparse = { indices: dto.sparse.indices, values: dto.sparse.values };
    } else if (dto.sparse) throw new BadRequestException('A sparse query needs a sparse vector space; choose one in Vector.');
    if (kind === 'binary') {
      if (!dto.vector) throw new BadRequestException(`'${vectorName}' is a binary vector; give the query as bits (0 and 1).`);
      if (dto.vector.some((b) => b !== 0 && b !== 1)) throw new BadRequestException('A binary query vector is bits: 0 and 1 only.');
    }
    if (kind === 'dense') {
      if (mode === 'dense' && !!dto.text === !!dto.vector) throw new BadRequestException('Give either text (embedded with the project’s embedding model) or a vector, not both.');
      if (mode !== 'dense' && (!dto.text || dto.vector)) throw new BadRequestException(`A ${mode} search takes text only.`);
    }

    // Hybrid: fused here (rank or weighted scores), or by the database.
    const fusion = mode === 'hybrid' ? (dto.fusion ?? 'rrf') : null;
    if (mode !== 'hybrid' && dto.fusion) throw new BadRequestException('Fusion applies to hybrid search only.');
    if (fusion === 'native') {
      if (!adapter.nativeHybrid) throw new BadRequestException('This database has no hybrid search of its own here; use rrf or weighted fusion.');
      if (dto.minScore !== undefined) throw new BadRequestException('A minimum score cannot be applied to the database’s own hybrid ranking; use rrf or weighted fusion.');
    } else if (mode !== 'dense' && !adapter.keywordSearch) {
      throw new BadRequestException(`${mode === 'hybrid' ? 'Hybrid' : 'Keyword'} search needs keyword ranking, which this database does not offer here.`);
    }

    let vector = dto.vector ?? null;
    let embedding: { providerId: string; modelId: string; live: boolean } | null = null;
    if (dto.text && mode !== 'keyword') {
      if (!pipeline) throw new BadRequestException('Text search embeds the query with the project’s embedding model; complete Data & Embedding design first, or search with a vector.');
      // Embedded exactly as ingestion embeds documents, so query and records share one vector space.
      const e = await this.embeddings.embed({ providerId: pipeline.embeddingProviderId, modelId: pipeline.embeddingModelId, dimension: pipeline.embeddingDimension, text: dto.text });
      vector = e.vector;
      embedding = { providerId: pipeline.embeddingProviderId, modelId: pipeline.embeddingModelId, live: e.isLiveProvider };
    }
    if (vector && kind !== 'sparse' && dimension !== null && vector.length !== dimension) {
      const unit = kind === 'binary' ? 'bits' : 'dimensions';
      throw new BadRequestException(`The query vector has ${vector.length} ${unit}; the ${vectorName ? `vector '${vectorName}'` : 'collection'} holds ${dimension}.`);
    }

    const filter = await this.filterFor(adapter, name, dto.filter);
    const topK = dto.topK ?? 10;
    const alpha = dto.alpha ?? 0.5;
    const candidates = Math.min(MAX_HYBRID_CANDIDATES, topK * HYBRID_CANDIDATES_PER_RESULT);
    const minScore = dto.minScore;
    const above = <T extends { score: number }>(list: T[]) => (minScore === undefined ? list : list.filter((r) => r.score >= minScore));
    const scope = { ...(vectorName ? { vectorName } : {}), ...(partition ? { partition } : {}) };
    const started = process.hrtime.bigint();
    let results;
    let removed = 0;
    let lists: { dense: number; keyword: number } | null = null;
    if (mode === 'dense') {
      const all = await this.call('search', () => adapter.searchFiltered(name, { vector: vector ?? [], ...(sparse ? { sparse } : {}), topK, filter, ...scope }));
      results = above(all);
      removed = all.length - results.length;
    } else if (mode === 'keyword') {
      const all = await this.call('keyword search', () => adapter.keywordSearch!(name, { text: dto.text!, topK, filter, ...(partition ? { partition } : {}) }));
      results = above(all);
      removed = all.length - results.length;
    } else if (fusion === 'native') {
      results = await this.call('hybrid search', () => adapter.nativeHybrid!(name, { text: dto.text!, vector: vector!, alpha, topK, filter, ...scope }));
    } else {
      // Both searches run together; the minimum score trims the dense candidates before fusion.
      const [denseAll, keyword] = await Promise.all([
        this.call('search', () => adapter.searchFiltered(name, { vector: vector!, topK: candidates, filter, ...scope })),
        this.call('keyword search', () => adapter.keywordSearch!(name, { text: dto.text!, topK: candidates, filter, ...(partition ? { partition } : {}) })),
      ]);
      const dense = above(denseAll);
      removed = denseAll.length - dense.length;
      lists = { dense: dense.length, keyword: keyword.length };
      results = fusion === 'weighted' ? fuseWeighted(dense, keyword, alpha, topK) : fuseResults(dense, keyword, alpha, topK);
    }
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    const target = discovery?.assessment.targetP95LatencyMs ?? null;
    return {
      collection: name,
      mode,
      vectorName: vectorName ?? null,
      vectorKind: kind,
      partition: partition ?? null,
      alpha: mode === 'hybrid' ? alpha : null,
      fusion,
      keywordRanking: mode === 'dense' ? null : fusion === 'native' ? adapter.nativeHybridRanking ?? null : adapter.keywordRanking ?? null,
      topK,
      filter,
      results,
      stats: scoreStats(results),
      queryStats: mode === 'keyword' ? null : queryStats({ vector, sparse, binary: kind === 'binary' }),
      threshold: minScore === undefined ? null : { minScore, removed, appliedTo: mode === 'hybrid' ? 'dense candidates, before fusion' : `${mode} scores` },
      candidates: lists,
      latencyMs,
      targetP95LatencyMs: target,
      withinTarget: target === null ? null : latencyMs <= target,
      embedding,
      notes: [
        fusion === 'rrf'
          ? `Hybrid: ${candidates} candidates each way, fused by rank (weighted reciprocal rank fusion, ${Math.round(alpha * 100)}% dense / ${Math.round((1 - alpha) * 100)}% keyword). Fused scores rank results; they are not similarities.`
          : fusion === 'weighted'
            ? `Hybrid: ${candidates} candidates each way; each list's scores rescaled to 0-1 and combined ${Math.round(alpha * 100)}% dense / ${Math.round((1 - alpha) * 100)}% keyword. Keeps how far apart scores are, so one outlier can dominate.`
            : fusion === 'native'
              ? `Hybrid by the database itself: ${adapter.nativeHybridRanking ?? 'its own fusion'}. Its scores are the database's own.`
              : null,
        minScore !== undefined && removed ? `${removed} result(s) below the minimum score ${minScore} were dropped${mode === 'hybrid' ? ' from the dense candidates' : ''}, so fewer than Top K may show.` : null,
        `${mode === 'hybrid' && fusion !== 'native' ? 'Both searches, run together,' : 'One query,'} timed from this server including the network - an indication, not a P95; the Performance phase measures percentiles.`,
        embedding && !embedding.live ? 'The embedding provider was not reachable, so the query used the offline stand-in embedding. Results are only meaningful if the records were ingested the same way.' : null,
      ].filter(Boolean),
    };
  }
}
