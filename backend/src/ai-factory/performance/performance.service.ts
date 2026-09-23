import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../../data-pipeline/data-pipeline-design.entity';
import { IndexDesign } from '../../index-design/index-design.entity';
import { ArchitectureDecisionRecord } from '../../vector-db-selection/architecture-decision-record.entity';
import { OptimizationReport } from '../../benchmark/optimization-report.entity';
import { IngestionRun } from '../../ingestion/ingestion-run.entity';
import { IngestionRunStatus } from '../../ingestion/enums/ingestion-run-status.enum';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { InferenceConfigService } from '../../inference/inference-config.service';
import { ChunkingStrategy } from '../../chunking/enums/chunking-strategy.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { AiInferenceArchitecture } from '../inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from '../infrastructure/infrastructure.entity';
import { AiRagAgentDesign } from '../rag-agent/rag-agent.entity';
import { AiPerformanceAssessment } from './performance.entity';
import { assessPerformance } from './performance.engine';
import { CreatePerformanceAssessmentDto, MeasurementDto } from './create-performance-assessment.dto';
import { EstimateValue, MeasuredValue, MetricGroup, MetricInputs, PerformanceCatalogue, PerformanceContext, PerformanceResult, TargetValue } from './performance.types';

export interface PerformanceInputs {
  profile: AiWorkloadProfile | null;
  discovery: DiscoveryAssessment | null;
  pipeline: DataPipelineDesign | null;
  indexDesign: IndexDesign | null;
  adr: ArchitectureDecisionRecord | null;
  optimization: OptimizationReport | null;
  ingestion: IngestionRun | null;
  inference: InferenceAssessment | null;
  selection: AiModelSelection | null;
  architecture: AiInferenceArchitecture | null;
  infrastructure: AiInfrastructureDesign | null;
  ragAgent: AiRagAgentDesign | null;
}

const date = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Pure: resolves every metric's target, estimate and measurement from the upstream records, and labels each. */
export function resolvePerformanceContext(dto: CreatePerformanceAssessmentDto, x: PerformanceInputs, cat: PerformanceCatalogue, charsPerToken: number, gpuMemory: (id: string) => number | null): PerformanceContext {
  if (!x.discovery && !x.inference) throw new BadRequestException('Nothing to assess yet - complete Discovery (vector track) or the Inference assessment first.');
  const d = x.discovery;
  const dv = d ? `Discovery v${d.version}` : '';
  const at = cat.assumedTargets;
  const metrics: Record<string, MetricInputs> = {};
  const target = (value: number | null | undefined, source: string, assumed = false): TargetValue | null => (value === null || value === undefined || !Number.isFinite(value) ? null : { value: round(value), source, assumed });
  const estimate = (value: number | null | undefined, evidenceType: EstimateValue['evidenceType'], source: string): EstimateValue | null => (value === null || value === undefined || !Number.isFinite(value) ? null : { value: round(value), evidenceType, source });

  // The design each group's measurements must post-date to still describe it.
  const designDate: Record<MetricGroup, { at: Date | null; what: string }> = {
    vector: [x.indexDesign && { at: x.indexDesign.createdAt, what: `Index design v${x.indexDesign.version}` }, x.adr && { at: x.adr.createdAt, what: 'the Vector DB decision' }]
      .filter(Boolean)
      .sort((a, b) => +new Date(b!.at) - +new Date(a!.at))[0] ?? { at: null, what: '' },
    embedding: x.pipeline ? { at: x.pipeline.createdAt, what: `Data Pipeline Design v${x.pipeline.version}` } : { at: null, what: '' },
    llm: x.architecture ? { at: x.architecture.createdAt, what: `Inference Architecture v${x.architecture.version}` } : x.inference ? { at: x.inference.createdAt, what: `Inference assessment v${x.inference.version}` } : { at: null, what: '' },
    infrastructure: x.infrastructure ? { at: x.infrastructure.createdAt, what: `Infrastructure Design v${x.infrastructure.version}` } : x.inference ? { at: x.inference.createdAt, what: `Inference assessment v${x.inference.version}` } : { at: null, what: '' },
  };
  const staleCaveat = (group: MetricGroup, measuredAt: Date | string | null) => {
    const dd = designDate[group];
    // By calendar day: a result dated the same day as the design (a date-only measuredAt is midnight) is not stale.
    return dd.at && measuredAt && date(measuredAt)! < date(dd.at)! ? [`Measured before ${dd.what} - re-run to confirm it still holds.`] : [];
  };
  const reported = (id: string, group: MetricGroup): MeasuredValue | null => {
    const m = (dto.measurements ?? []).filter((k: MeasurementDto) => k.metric === id).pop();
    return m ? { value: m.value, source: `Recorded by the architect: ${m.source}`, measuredAt: m.measuredAt ?? null, reported: true, caveats: staleCaveat(group, m.measuredAt ?? null) } : null;
  };

  // --------------------------------------------------------------- vector
  const opt = x.optimization;
  const best = opt?.recommendedVariant;
  const vectorCount = d?.estimatedVectorCount ?? null;
  const sampleCaveat =
    opt && vectorCount && opt.sampleSize < vectorCount * cat.sampleCheck.minShare && opt.sampleSize < cat.sampleCheck.minSampleVectors
      ? [`Benchmark ran on ${opt.sampleSize.toLocaleString()} vectors against ~${vectorCount.toLocaleString()} expected - confirm at production scale.`]
      : [];
  const platformVector = (value: number | undefined): MeasuredValue | null =>
    opt && best && value !== undefined
      ? {
          value: round(value, 3),
          source: `Optimization benchmark v${opt.version} (${best.searchParamName}=${best.searchParamValue}, ${opt.queryCount.toLocaleString()} queries, top-${opt.topK})`,
          measuredAt: date(opt.createdAt),
          reported: false,
          caveats: [...sampleCaveat, ...staleCaveat('vector', opt.createdAt)],
        }
      : null;
  const vectorApplicable = !!d;
  const vec = (id: string, t: TargetValue | null, measured: MeasuredValue | null) => {
    metrics[id] = { applicable: vectorApplicable, notApplicableReason: 'No Discovery (vector track) yet.', target: t, estimate: null, measured: reported(id, 'vector') ?? measured };
  };
  vec('recall', target(d?.recallTarget, `${dv}: recall target`), platformVector(best?.avgRecall));
  vec('qps', target(d?.peakQps, `${dv}: peak QPS`), platformVector(best?.achievedQps));
  vec('search_latency_p95', target(d?.targetP95LatencyMs, `${dv}: P95 search target`), platformVector(best?.p95LatencyMs));
  vec('search_latency_p99', target(d?.targetP99LatencyMs, `${dv}: P99 search target`), platformVector(best?.p99LatencyMs));
  vec('index_build_time', null, null);

  // ------------------------------------------------------------ embedding
  const p = x.pipeline;
  const chunkTokens = p ? (p.chunkingStrategy === ChunkingStrategy.TOKEN_BASED ? p.chunkSize : Math.ceil(p.chunkSize / charsPerToken)) : null;
  const corpusChunks = d ? d.documentCount * d.chunksPerDocument : null;
  const corpusTokens = corpusChunks !== null && chunkTokens !== null ? corpusChunks * chunkTokens : null;
  const window = at.initialLoadHours * 3600;
  const run = x.ingestion && x.ingestion.status !== IngestionRunStatus.FAILED && x.ingestion.metrics.durationMs > 0 ? x.ingestion : null;
  const runCaveats = run
    ? [
        ...(run.metrics.documentsSubmitted < cat.sampleCheck.minIngestionDocuments ? [`Ingestion run covered ${run.metrics.documentsSubmitted.toLocaleString()} document(s) - too few to trust throughput.`] : []),
        ...staleCaveat('embedding', run.createdAt),
      ]
    : [];
  const runMeasured = (value: number | null): MeasuredValue | null =>
    run && value !== null ? { value: round(value), source: `Ingestion run v${run.version} (${run.metrics.documentsSubmitted.toLocaleString()} docs, ${run.metrics.chunksEmbedded.toLocaleString()} chunks in ${(run.metrics.durationMs / 1000).toFixed(1)} s)`, measuredAt: date(run.createdAt), reported: false, caveats: runCaveats } : null;
  const secs = run ? run.metrics.durationMs / 1000 : 0;
  const embApplicable = !!p;
  const loadAssumption = `assumption: initial corpus embedded within ${at.initialLoadHours} h`;
  metrics.embedding_tokens_per_sec = {
    applicable: embApplicable,
    notApplicableReason: 'No Data Pipeline Design yet.',
    target: target(corpusTokens !== null ? corpusTokens / window : null, `${loadAssumption} (~${corpusTokens?.toLocaleString()} tokens)`, true),
    estimate: null,
    measured: reported('embedding_tokens_per_sec', 'embedding') ?? runMeasured(run && chunkTokens && run.metrics.chunksEmbedded > 0 ? (run.metrics.chunksEmbedded * chunkTokens) / secs : null),
  };
  metrics.documents_per_sec = {
    applicable: embApplicable,
    notApplicableReason: 'No Data Pipeline Design yet.',
    target: target(d ? d.documentCount / window : null, `${loadAssumption} (${d?.documentCount.toLocaleString()} documents)`, true),
    estimate: null,
    measured: reported('documents_per_sec', 'embedding') ?? runMeasured(run && run.metrics.documentsSubmitted > 0 ? run.metrics.documentsSubmitted / secs : null),
  };
  metrics.embedding_cost = {
    applicable: embApplicable,
    notApplicableReason: 'No Data Pipeline Design yet.',
    target: null,
    estimate: estimate(p && corpusTokens !== null ? (corpusTokens / 1e6) * p.costPerMillionTokens : null, 'vendor_listed', p ? `${corpusTokens?.toLocaleString()} tokens × $${p.costPerMillionTokens} per 1M (catalogue list price)` : ''),
    measured: reported('embedding_cost', 'embedding'),
  };

  // ------------------------------------------------------------------ LLM
  const inf = x.inference;
  const rec = inf?.result.recommendedGpuOption ?? null;
  const lat = x.architecture?.result.architecture?.sla.latency ?? [];
  const row = (metric: string) => lat.find((l) => l.metric === metric);
  const ttft = row('Time to first token');
  const tpot = row('Time per output token');
  const iav = x.architecture ? `Inference Architecture v${x.architecture.version}` : '';
  const llmApplicable = !!inf;
  const llm = (id: string, t: TargetValue | null, e: EstimateValue | null) => {
    metrics[id] = { applicable: llmApplicable, notApplicableReason: 'No Inference assessment yet.', target: t, estimate: e, measured: reported(id, 'llm') };
  };
  const ttftTarget = inf?.inputsUsed.ttftTargetMs;
  llm('ttft_p50', null, estimate(ttft?.p50, 'estimated', `${iav}: P50 estimate`));
  llm('ttft_p95', target(ttftTarget, `Inference assessment v${inf?.version}: TTFT target`), estimate(ttft?.p95 ?? rec?.ttftMs, 'estimated', ttft ? `${iav}: P95 estimate` : `Inference assessment v${inf?.version}: sizing estimate`));
  llm('ttft_p99', null, estimate(ttft?.p99, 'estimated', `${iav}: P99 estimate`));
  const tpotTarget = inf?.inputsUsed.tpotTargetMs;
  const tpotEst = tpot?.p50 ?? rec?.tpotMs;
  llm('output_tokens_per_sec', target(tpotTarget ? 1000 / tpotTarget : null, `Inference assessment v${inf?.version}: ${tpotTarget} ms per token`), estimate(tpotEst ? 1000 / tpotEst : null, 'estimated', `${tpot ? iav : `Inference assessment v${inf?.version}`}: ${tpotEst} ms per token`));
  const rag = x.ragAgent?.result.latencyBudget;
  const e2eTarget = x.profile?.inputs.targetLatencyMs.value as number | null | undefined;
  llm(
    'e2e_p95',
    target(e2eTarget, `Workload Profile v${x.profile?.version}: target latency`),
    rag?.endToEndMs ? estimate(rag.endToEndMs, 'estimated', `RAG / Agent Architecture v${x.ragAgent!.version}: latency budget`) : estimate(row('End-to-end response')?.p95 ?? rec?.e2eLatencyMs, 'estimated', `${iav || `Inference assessment v${inf?.version}`}: end-to-end estimate`),
  );
  const accuracy = x.selection?.requirements.accuracyRequirement ?? 'standard';
  llm('quality', target(at.qualityByAccuracy[accuracy], `assumption: ${accuracy} accuracy requirement${x.selection ? ` (Model Selection v${x.selection.version})` : ''}`, true), null);

  // ------------------------------------------------------- infrastructure
  const selfHosted = !!rec && inf?.result.decision !== 'managed_api';
  const gpuMem = rec ? gpuMemory(rec.gpuId) : null;
  const demand = inf?.result.demand;
  metrics.gpu_utilization = {
    applicable: selfHosted,
    notApplicableReason: inf ? 'Managed API - no GPUs to operate.' : 'No Inference assessment yet.',
    target: target(at.gpuUtilizationMaxPercent, 'assumption: headroom at peak', true),
    estimate: estimate(rec && demand && rec.replicasAtPeak * rec.replicaCapacityRps > 0 ? (demand.peakRps / (rec.replicasAtPeak * rec.replicaCapacityRps)) * 100 : null, 'estimated', `Inference assessment v${inf?.version}: peak ${demand?.peakRps.toFixed(2)} req/s over ${rec?.replicasAtPeak} replica(s)`),
    measured: reported('gpu_utilization', 'infrastructure'),
  };
  metrics.gpu_memory = {
    applicable: selfHosted,
    notApplicableReason: inf ? 'Managed API - no GPUs to operate.' : 'No Inference assessment yet.',
    target: target(at.gpuMemoryMaxPercent, 'assumption: memory headroom', true),
    estimate: estimate(rec && gpuMem ? ((rec.footprint.weightsGb + rec.batchSize * rec.footprint.kvGbPerAvgSequence) / (gpuMem * rec.tensorParallel)) * 100 : null, 'estimated', `weights ${rec?.footprint.weightsGb} GB + batch ${rec?.batchSize} × KV per sequence, over ${rec?.tensorParallel} × ${gpuMem} GB`),
    measured: reported('gpu_memory', 'infrastructure'),
  };
  const est = x.adr?.infrastructureEstimate;
  const hostApplicable = !!x.adr;
  metrics.cpu_utilization = {
    applicable: hostApplicable,
    notApplicableReason: 'No Vector DB decision yet.',
    target: target(at.cpuUtilizationMaxPercent, 'assumption: headroom at peak', true),
    estimate: estimate(est && d?.availableCpuCores ? (est.estimatedCpuCores / d.availableCpuCores) * 100 : null, 'estimated', `Vector DB estimate ${est?.estimatedCpuCores} vCPU of ${d?.availableCpuCores} available (${dv})`),
    measured: reported('cpu_utilization', 'infrastructure'),
  };
  metrics.ram_utilization = {
    applicable: hostApplicable,
    notApplicableReason: 'No Vector DB decision yet.',
    target: target(at.ramUtilizationMaxPercent, 'assumption: headroom at peak', true),
    estimate: estimate(est && d?.availableRamGb ? (est.estimatedMemoryGb / d.availableRamGb) * 100 : null, 'estimated', `Vector DB estimate ${est?.estimatedMemoryGb} GB of ${d?.availableRamGb} GB available (${dv})`),
    measured: reported('ram_utilization', 'infrastructure'),
  };
  const model = x.infrastructure?.result.deploymentModel.kind;
  metrics.network = {
    applicable: !!x.infrastructure || !!inf,
    notApplicableReason: 'No Infrastructure Design or Inference assessment yet.',
    target: target(at.networkRoundTripMaxMs, 'assumption: per-hop allowance in the latency budget', true),
    estimate: model && model !== 'not_feasible' ? estimate(cat.networkEstimateMs[model], 'assumption', `${model === 'hybrid' ? 'hybrid - cross-target interconnect' : 'single target'} (Infrastructure Design v${x.infrastructure!.version})`) : null,
    measured: reported('network', 'infrastructure'),
  };

  const missingInputs = [
    !d && 'Discovery (vector track)',
    !x.pipeline && 'Data Pipeline Design',
    !inf && 'Inference assessment',
    !x.architecture && 'Inference Architecture (latency percentiles)',
    !x.adr && 'Vector DB decision',
  ].filter((k): k is string => !!k);
  return { metrics, missingInputs };
}

@Injectable()
export class PerformanceAssessmentService {
  private readonly logger = new Logger(PerformanceAssessmentService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    @InjectRepository(AiPerformanceAssessment) private readonly assessments: Repository<AiPerformanceAssessment>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(DataPipelineDesign) private readonly pipelines: Repository<DataPipelineDesign>,
    @InjectRepository(IndexDesign) private readonly indexDesigns: Repository<IndexDesign>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(OptimizationReport) private readonly optimizations: Repository<OptimizationReport>,
    @InjectRepository(IngestionRun) private readonly ingestions: Repository<IngestionRun>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiModelSelection) private readonly selections: Repository<AiModelSelection>,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(AiInfrastructureDesign) private readonly infrastructure: Repository<AiInfrastructureDesign>,
    @InjectRepository(AiRagAgentDesign) private readonly ragAgent: Repository<AiRagAgentDesign>,
  ) {}

  private async resolve(projectId: string, requester: AuthenticatedUser, dto: CreatePerformanceAssessmentDto) {
    await this.projectsService.findOne(projectId, requester);
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [profile, discovery, pipeline, indexDesign, adr, optimization, ingestion, inference, selection, architecture, infrastructure, ragAgent] = await Promise.all([
      this.profiles.findOne({ where, order }),
      this.discovery.findOne({ where, order }),
      this.pipelines.findOne({ where, order }),
      this.indexDesigns.findOne({ where, order }),
      this.adrs.findOne({ where, order }),
      this.optimizations.findOne({ where, order }),
      this.ingestions.findOne({ where, order }),
      this.inference.findOne({ where, order }),
      this.selections.findOne({ where, order }),
      this.architectures.findOne({ where, order }),
      this.infrastructure.findOne({ where, order }),
      this.ragAgent.findOne({ where, order }),
    ]);
    const gpuMemory = (id: string) => this.inferenceConfig.getGpus().find((g) => g.id === id)?.memoryGb ?? null;
    return resolvePerformanceContext(
      dto,
      { profile, discovery, pipeline, indexDesign, adr, optimization, ingestion, inference, selection, architecture, infrastructure, ragAgent },
      this.cfg.getPerformanceCatalogue(),
      this.cfg.getEmbeddingEligibilityRules().charsPerToken,
      gpuMemory,
    );
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: PerformanceContext; preview: PerformanceResult }> {
    const context = await this.resolve(projectId, requester, {});
    return { context, preview: assessPerformance(context, this.cfg.getPerformanceCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreatePerformanceAssessmentDto): Promise<AiPerformanceAssessment> {
    const context = await this.resolve(projectId, requester, dto);
    const result = assessPerformance(context, this.cfg.getPerformanceCatalogue());
    const version = (await this.assessments.count({ where: { project: { id: projectId } } })) + 1;
    const sources = { measurements: { source: (dto.measurements ?? []).length ? 'user' : 'default', detail: `${(dto.measurements ?? []).length} measurement(s) recorded by the architect` } };
    const saved = await this.assessments.save(
      this.assessments.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: dto, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=assess_performance projectId=${projectId} version=${version} status=${result.status.status} measured=${result.counts.pass + result.counts.pass_with_conditions + result.counts.fail} requiresBenchmark=${result.counts.requires_benchmark}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiPerformanceAssessment | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.assessments.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
