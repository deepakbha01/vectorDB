import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiFactoryService } from '../ai-factory.service';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../../features/features.controller';
import { AiFinalRecommendation, FinalProvenance } from './final.entity';
import { buildFinalRecommendation } from './final.engine';
import { FinalInputs, FinalResult, RoadmapFacts } from './final.types';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { InferenceConfigService } from '../../inference/inference-config.service';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { AiInfrastructureDesign } from '../infrastructure/infrastructure.entity';

/**
 * Final AI Architecture Recommendation (spec §15-§18, §25, §26). Reads the AI
 * Factory's own view of the project - lineage, central state and every
 * decision record - so it combines exactly what the other phases decided.
 */
@Injectable()
export class FinalRecommendationService {
  private readonly logger = new Logger(FinalRecommendationService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly aiFactory: AiFactoryService,
    private readonly config: ConfigService,
    private readonly cfg: AiFactoryConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    @InjectRepository(AiFinalRecommendation) private readonly finals: Repository<AiFinalRecommendation>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiInfrastructureDesign) private readonly infrastructure: Repository<AiInfrastructureDesign>,
  ) {}

  private async inputs(projectId: string, requester: AuthenticatedUser): Promise<FinalInputs> {
    const project = await this.projectsService.findOne(projectId, requester);
    const [overview, decisions] = await Promise.all([this.aiFactory.getOverview(projectId, requester), this.aiFactory.getDecisionRecords(projectId, requester)]);
    // Token evidence joins the cost gate only where Token Observability is switched on.
    const tokenObservability = new FeaturesController(this.config).flags().tokenObservability;
    return { projectName: project.name, state: overview.state, lineage: overview.phases, decisions, tokenObservability, roadmap: await this.roadmapFacts(projectId) };
  }

  /** Next-generation facts from the latest Inference and Infrastructure records (the decision records do not carry them). */
  private async roadmapFacts(projectId: string): Promise<RoadmapFacts> {
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [inf, infra] = await Promise.all([this.inference.findOne({ where, order }), this.infrastructure.findOne({ where, order })]);

    let nextGeneration: RoadmapFacts['nextGeneration'] = null;
    const ng = inf?.result.nextGenerationOption ?? null;
    if (inf && ng) {
      const r = inf.result;
      const rec = r.recommendedGpuOption;
      const today =
        r.decision === 'managed_api'
          ? `Managed API (${r.managedApi.tierLabel})`
          : rec
            ? `${rec.totalGpusAtPeak} × ${rec.gpuLabel} (${rec.precision.toUpperCase()})`
            : 'No configuration meets the latency targets';
      const sys = this.inferenceConfig.systemForGpu(ng.option.gpuId);
      nextGeneration = {
        inferenceVersion: inf.version,
        today,
        option: `${ng.option.totalGpusAtPeak} × ${ng.option.gpuLabel} (${ng.option.precision.toUpperCase()})`,
        precision: ng.option.precision,
        meetsTargets: ng.option.meetsTtft && ng.option.meetsTpot,
        comparison: ng.comparison,
        availabilityNote: ng.availabilityNote,
        rackSystem: sys ? { label: sys.label, rackPowerKw: sys.rackPowerKw, rackPowerEstimated: !!sys.rackPowerEstimated, cooling: sys.cooling, cpuLabel: sys.cpuLabel } : null,
      };
    }

    // A preview host CPU only matters when CPU nodes actually land on-premises.
    let previewHostCpu: RoadmapFacts['previewHostCpu'] = null;
    const host = infra?.context.hostCpu ? this.cfg.getInfrastructureCatalogue().hostCpus?.[infra.context.hostCpu] : undefined;
    const cpuOnPrem = !!infra?.result.placements.some((p) => p.component !== 'inference' && p.chosen?.target === 'on_premises');
    if (infra && host?.availability === 'preview' && cpuOnPrem) {
      previewHostCpu = { infrastructureVersion: infra.version, label: host.label.split(' (')[0], availabilityNote: host.availabilityNote ?? 'Not yet generally available.' };
    }
    return { nextGeneration, previewHostCpu };
  }

  async preview(projectId: string, requester: AuthenticatedUser): Promise<FinalResult> {
    return buildFinalRecommendation(await this.inputs(projectId, requester));
  }

  async submit(projectId: string, requester: AuthenticatedUser): Promise<AiFinalRecommendation> {
    const x = await this.inputs(projectId, requester);
    const result = buildFinalRecommendation(x);
    // What this version was built from, so a later reader can tell which records it reflects.
    const context: FinalProvenance = { phases: x.lineage.filter((l) => l.phase !== 'final_recommendation').map((l) => ({ phase: l.phase, version: l.latest?.version ?? null, status: l.status })) };
    const version = (await this.finals.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.finals.save(
      this.finals.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: {}, context, sources: {}, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=final_recommendation projectId=${projectId} version=${version} readiness=${result.readiness.status} confidence=${result.executiveSummary.confidence}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiFinalRecommendation | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.finals.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
