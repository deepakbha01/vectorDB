import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OptimizationReport } from './optimization-report.entity';
import { CreateBenchmarkDto } from './dto/create-benchmark.dto';
import { VariantResult } from './benchmark.types';
import { bruteForceTopK, percentile, recallAtK, syntheticUnitVector } from './benchmark-math';
import { ProjectsService } from '../projects/projects.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { VectorAdapterFactory } from '../database-adapters/vector-adapter.factory';
import { SearchMode } from '../database-adapters/vector-database-adapter.interface';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';

const UPSERT_BATCH_SIZE = 500;
const DEFAULT_THROUGHPUT_CONCURRENCY = 4;
/** Queries run on an exact scan: enough to show it is not an index, without reading the table hundreds of times. */
const EXACT_SCAN_MAX_QUERIES = 20;

export const EXACT_SCAN_NOTE =
  'Not representative: the target has no vector index support (PostgreSQL without pgvector), so every search was an exact ' +
  'scan in the application. The search parameter was not applied, recall is 1 by construction, and latency does not describe ' +
  'the tuned index; throughput under load was not measured. Install pgvector on the target and re-run this benchmark.';

/**
 * Sends every item through `fn` with `workers` running in parallel (each takes
 * the next item when it finishes one) and returns the wall-clock milliseconds -
 * throughput is items / that time, unlike a one-at-a-time pass which only
 * measures 1 / latency.
 */
export async function runConcurrently<T>(items: T[], workers: number, fn: (item: T) => Promise<unknown>): Promise<number> {
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    }),
  );
  return Date.now() - started;
}

@Injectable()
export class BenchmarkService {
  private readonly logger = new Logger(BenchmarkService.name);

  constructor(
    @InjectRepository(OptimizationReport) private readonly reports: Repository<OptimizationReport>,
    private readonly projectsService: ProjectsService,
    private readonly indexDesignService: IndexDesignService,
    private readonly indexRecommendationEngine: IndexRecommendationEngineService,
    private readonly platformConfig: PlatformConfigService,
    private readonly adapterFactory: VectorAdapterFactory,
  ) {}

  async runBenchmark(projectId: string, requester: AuthenticatedUser, dto: CreateBenchmarkDto): Promise<OptimizationReport> {
    const project = await this.projectsService.findOne(projectId, requester);
    if (project.platform === VectorPlatform.UNDETERMINED) {
      throw new BadRequestException('Complete Phase 4 Vector DB Selection (or manually select a platform) before benchmarking.');
    }
    const indexDesign = await this.indexDesignService.getLatest(projectId, requester);
    if (!indexDesign) {
      throw new BadRequestException('Complete Phase 3 (Index Design) before benchmarking.');
    }

    const defaults = this.platformConfig.getBenchmarkDefaults();
    const indexTypeDefaults = defaults[indexDesign.decision];
    const sampleSize = dto.sampleSize ?? defaults.sampleSize;
    const queryCount = Math.min(dto.queryCount ?? defaults.queryCount, sampleSize);
    const topK = dto.topK ?? defaults.topK;
    const concurrency = dto.concurrency ?? defaults.throughputConcurrency ?? DEFAULT_THROUGHPUT_CONCURRENCY;
    const dimension = indexDesign.inputsUsed.dimension;
    const searchParamName: string = indexTypeDefaults.searchParamName;
    const baselineValue: number =
      indexDesign.configuration.find((c) => c.name === searchParamName)?.value ?? indexTypeDefaults.variants[0];
    const variantValues = Array.from(new Set<number>([...(dto.variants ?? indexTypeDefaults.variants), baselineValue])).sort(
      (a, b) => a - b,
    );

    const corpus = Array.from({ length: sampleSize }, (_, i) => ({ id: `bench-${i}`, vector: syntheticUnitVector(i, dimension) }));
    const step = Math.max(1, Math.floor(sampleSize / queryCount));
    const queries = Array.from({ length: queryCount }, (_, i) => corpus[(i * step) % sampleSize]);
    const groundTruth = new Map(queries.map((q) => [q.id, bruteForceTopK(q.vector, corpus, topK)]));

    const adapter = await this.adapterFactory.forProject(project);
    const collectionName = `bench_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    let variantResults: VariantResult[];
    let searchMode: SearchMode = 'ann';
    let runValues = variantValues;
    let runQueries = queries;
    try {
      await adapter.createSchema({ collectionOrTableName: collectionName, dimension, metric: indexDesign.inputsUsed.metric, metadataFields: [] });
      searchMode = (await adapter.searchMode?.()) ?? 'ann';
      await adapter.createVectorIndex(collectionName, indexDesign.decision, indexDesign.configuration, indexDesign.inputsUsed.metric);
      for (let i = 0; i < corpus.length; i += UPSERT_BATCH_SIZE) {
        const batch = corpus.slice(i, i + UPSERT_BATCH_SIZE).map((c) => ({ id: c.id, vector: c.vector, metadata: {} }));
        await adapter.upsert(collectionName, batch);
      }

      // An exact scan ignores the search parameter, so every variant would be identical - and each search
      // reads the whole table into the application, which is slow. Run only the baseline, on a few queries.
      if (searchMode === 'exact_scan') {
        runValues = [baselineValue];
        runQueries = queries.slice(0, EXACT_SCAN_MAX_QUERIES);
      }

      variantResults = [];
      for (const value of runValues) {
        const latencies: number[] = [];
        let recallSum = 0;
        for (const query of runQueries) {
          const start = Date.now();
          const results = await adapter.search(collectionName, { vector: query.vector, topK, searchParams: { [searchParamName]: value } });
          latencies.push(Date.now() - start);
          recallSum += recallAtK(results.map((r) => r.id), groundTruth.get(query.id) ?? []);
        }
        const totalSeconds = latencies.reduce((a, b) => a + b, 0) / 1000;
        // Load pass: the same queries from `concurrency` parallel clients. Latency and recall come
        // from the one-at-a-time pass above (unaffected by queueing); throughput comes from here.
        // Skipped on an exact scan: it would only measure the application comparing every row, slowly.
        const loadMs =
          searchMode === 'ann'
            ? await runConcurrently(runQueries, concurrency, (query) =>
                adapter.search(collectionName, { vector: query.vector, topK, searchParams: { [searchParamName]: value } }),
              )
            : null;
        variantResults.push({
          searchParamName,
          searchParamValue: value,
          isBaseline: value === baselineValue,
          p50LatencyMs: percentile(latencies, 50),
          p95LatencyMs: percentile(latencies, 95),
          p99LatencyMs: percentile(latencies, 99),
          avgRecall: Number((recallSum / runQueries.length).toFixed(4)),
          achievedQps: totalSeconds > 0 ? Number((runQueries.length / totalSeconds).toFixed(2)) : 0,
          ...(loadMs !== null && {
            // At least 1ms: a run too fast to time must not read as zero throughput.
            sustainedQps: Number((runQueries.length / (Math.max(1, loadMs) / 1000)).toFixed(2)),
            concurrency,
          }),
        });
      }
    } finally {
      await adapter.dropSchema(collectionName, true).catch((error) => {
        this.logger.error(`Failed to clean up ephemeral benchmark collection '${collectionName}': ${(error as Error).message}`);
      });
    }

    const catalogEntry = this.platformConfig.getIndexCatalog().find((c) => c.id === indexDesign.decision)!;
    const estimatedMemoryGb = this.indexRecommendationEngine.estimateMemoryGb(indexDesign.decision, catalogEntry, sampleSize, dimension);
    const estimatedCostPerHourUsd = Number((estimatedMemoryGb * defaults.costPerGbHourUsd).toFixed(4));

    const targetP95 = indexDesign.inputsUsed.targetP95LatencyMs;
    const targetRecall = indexDesign.inputsUsed.recallTarget;
    const bottlenecks =
      searchMode === 'exact_scan'
        ? [EXACT_SCAN_NOTE]
        : this.identifyBottlenecks(variantResults, targetP95, targetRecall);
    const recommendedVariant = this.pickRecommendedVariant(variantResults, targetP95, targetRecall);
    const baseline = variantResults.find((v) => v.isBaseline)!;

    const previousCount = await this.reports.count({ where: { project: { id: projectId } } });
    const report = await this.reports.save(
      this.reports.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version: previousCount + 1,
        indexType: indexDesign.decision,
        baselineConfiguration: indexDesign.configuration,
        sampleSize,
        queryCount: runQueries.length, // what was actually run - fewer on an exact scan
        topK,
        variantResults,
        recommendedVariant,
        bottlenecks,
        beforeAfterComparison: { baseline, recommended: recommendedVariant },
        capacityImpact: { estimatedMemoryGb },
        costImplications: { estimatedCostPerHourUsd },
        searchMode,
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.OPTIMIZATION, PhaseStatus.COMPLETED);

    this.logger.log(
      `user=${requester.email} action=run_benchmark projectId=${projectId} version=${report.version} indexType=${indexDesign.decision} ` +
        `recommended=${searchParamName}:${recommendedVariant.searchParamValue}`,
    );

    return report;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<OptimizationReport | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.reports.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<OptimizationReport[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.reports.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  private identifyBottlenecks(variants: VariantResult[], targetP95: number, targetRecall: number): string[] {
    const bottlenecks: string[] = [];
    const overLatency = variants.filter((v) => v.p95LatencyMs > targetP95);
    const underRecall = variants.filter((v) => v.avgRecall < targetRecall);

    if (overLatency.length === variants.length) {
      bottlenecks.push(`Every tested configuration exceeds the ${targetP95}ms P95 latency target - consider a cheaper index type or relaxing the SLA.`);
    } else if (overLatency.length > 0) {
      bottlenecks.push(`${overLatency.length} of ${variants.length} configurations exceed the ${targetP95}ms P95 latency target.`);
    }

    if (underRecall.length === variants.length) {
      bottlenecks.push(`Every tested configuration falls short of the ${targetRecall} recall target - consider HNSW or a higher search-time parameter range.`);
    } else if (underRecall.length > 0) {
      bottlenecks.push(`${underRecall.length} of ${variants.length} configurations fall short of the ${targetRecall} recall target.`);
    }

    if (bottlenecks.length === 0) {
      bottlenecks.push('No bottlenecks identified - at least one tested configuration meets both the latency and recall targets.');
    }
    return bottlenecks;
  }

  private pickRecommendedVariant(variants: VariantResult[], targetP95: number, targetRecall: number): VariantResult {
    const meetsBoth = variants
      .filter((v) => v.p95LatencyMs <= targetP95 && v.avgRecall >= targetRecall)
      .sort((a, b) => b.avgRecall - a.avgRecall || a.p95LatencyMs - b.p95LatencyMs);
    if (meetsBoth.length > 0) return meetsBoth[0];

    const meetsLatency = variants.filter((v) => v.p95LatencyMs <= targetP95).sort((a, b) => b.avgRecall - a.avgRecall);
    if (meetsLatency.length > 0) return meetsLatency[0];

    return [...variants].sort((a, b) => a.p95LatencyMs - b.p95LatencyMs)[0];
  }
}
