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
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';

const UPSERT_BATCH_SIZE = 500;

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

    const adapter = this.adapterFactory.getAdapter(project.platform);
    const collectionName = `bench_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    let variantResults: VariantResult[];
    try {
      await adapter.createSchema({ collectionOrTableName: collectionName, dimension, metric: indexDesign.inputsUsed.metric, metadataFields: [] });
      await adapter.createVectorIndex(collectionName, indexDesign.decision, indexDesign.configuration, indexDesign.inputsUsed.metric);
      for (let i = 0; i < corpus.length; i += UPSERT_BATCH_SIZE) {
        const batch = corpus.slice(i, i + UPSERT_BATCH_SIZE).map((c) => ({ id: c.id, vector: c.vector, metadata: {} }));
        await adapter.upsert(collectionName, batch);
      }

      variantResults = [];
      for (const value of variantValues) {
        const latencies: number[] = [];
        let recallSum = 0;
        for (const query of queries) {
          const start = Date.now();
          const results = await adapter.search(collectionName, { vector: query.vector, topK, searchParams: { [searchParamName]: value } });
          latencies.push(Date.now() - start);
          recallSum += recallAtK(results.map((r) => r.id), groundTruth.get(query.id) ?? []);
        }
        const totalSeconds = latencies.reduce((a, b) => a + b, 0) / 1000;
        variantResults.push({
          searchParamName,
          searchParamValue: value,
          isBaseline: value === baselineValue,
          p50LatencyMs: percentile(latencies, 50),
          p95LatencyMs: percentile(latencies, 95),
          p99LatencyMs: percentile(latencies, 99),
          avgRecall: Number((recallSum / queries.length).toFixed(4)),
          achievedQps: totalSeconds > 0 ? Number((queries.length / totalSeconds).toFixed(2)) : 0,
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
    const bottlenecks = this.identifyBottlenecks(variantResults, targetP95, targetRecall);
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
        queryCount,
        topK,
        variantResults,
        recommendedVariant,
        bottlenecks,
        beforeAfterComparison: { baseline, recommended: recommendedVariant },
        capacityImpact: { estimatedMemoryGb },
        costImplications: { estimatedCostPerHourUsd },
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
