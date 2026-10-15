import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexDesign, IndexDesignInputs, ParameterOverride } from './index-design.entity';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { TuningParameter } from '../index-recommendation-engine/index-recommendation.types';
import { CreateIndexDesignDto } from './dto/create-index-design.dto';
import { ProjectsService } from '../projects/projects.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { Project } from '../projects/project.entity';
import { ProjectPhase, PhaseStatus } from '../projects/enums/project-status.enum';

@Injectable()
export class IndexDesignService {
  private readonly logger = new Logger(IndexDesignService.name);

  constructor(
    @InjectRepository(IndexDesign) private readonly designs: Repository<IndexDesign>,
    private readonly projectsService: ProjectsService,
    private readonly dataPipelineDesignService: DataPipelineDesignService,
    private readonly engine: IndexRecommendationEngineService,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  async submitDesign(projectId: string, requester: AuthenticatedUser, dto: CreateIndexDesignDto): Promise<IndexDesign> {
    await this.projectsService.findOne(projectId, requester);

    const input = await this.resolveInput(projectId, requester, dto);
    const result = this.engine.evaluate(input);
    const { configuration, overrides } = this.applyOverrides(result.decision, result.configuration, dto);

    const previousCount = await this.designs.count({ where: { project: { id: projectId } } });
    const version = previousCount + 1;

    const design = await this.designs.save(
      this.designs.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        version,
        rulesVersion: result.rulesVersion,
        decision: result.decision,
        label: result.label,
        rationale: result.rationale,
        configuration,
        impact: result.impact,
        scalingConsiderations: overrides
          ? [...result.scalingConsiderations, 'Tuning parameters were overridden by the architect - memory, build time and recall above are the engine estimates for its own values; re-run the Optimization benchmark to measure the overridden ones.']
          : result.scalingConsiderations,
        parameterOverrides: overrides,
        overrideRationale: overrides ? dto.overrideRationale!.trim() : null,
        options: result.options,
        alternatives: result.alternatives,
        criteriaWeights: result.criteriaWeights,
        updateFrequency: dto.updateFrequency,
        inputsUsed: input,
      }),
    );

    await this.projectsService.updatePhaseStatus(projectId, requester, ProjectPhase.INDEX_DESIGN, PhaseStatus.COMPLETED);

    this.logger.log(
      `user=${requester.email} action=submit_index_design projectId=${projectId} version=${version} decision=${result.decision}`,
    );

    return design;
  }

  /** Tuning parameters per index type with their bounds and defaults (config/indexes.yaml), for the override form. */
  getParameterBounds(): Record<string, Record<string, { min: number; max: number; default: number; description: string }>> {
    return Object.fromEntries(
      this.platformConfig.getIndexCatalog().map((c) => [
        c.id,
        Object.fromEntries(Object.entries((c.parameters ?? {}) as Record<string, any>).map(([k, p]) => [k, { min: p.min, max: p.max, default: p.default, description: p.description }])),
      ]),
    );
  }

  /**
   * Replaces the engine's tuning values with the architect's, each checked against the
   * recommended index's parameters and bounds; the engine's value is kept for audit.
   * Overrides equal to the engine's value are dropped.
   */
  private applyOverrides(indexType: string, configuration: TuningParameter[], dto: CreateIndexDesignDto): { configuration: TuningParameter[]; overrides: ParameterOverride[] | null } {
    const requested = dto.parameterOverrides ?? [];
    if (!requested.length) return { configuration, overrides: null };
    const bounds = this.getParameterBounds()[indexType] ?? {};
    const names = new Set<string>();
    const overrides: ParameterOverride[] = [];
    for (const o of requested) {
      const current = configuration.find((c) => c.name === o.name);
      const b = bounds[o.name];
      if (!current || !b) {
        throw new BadRequestException(`'${o.name}' is not a tuning parameter of the recommended ${indexType} index - use ${configuration.map((c) => c.name).join(', ')}.`);
      }
      if (names.has(o.name)) throw new BadRequestException(`'${o.name}' is overridden more than once.`);
      names.add(o.name);
      if (o.value < b.min || o.value > b.max) throw new BadRequestException(`${o.name} must be between ${b.min} and ${b.max} (got ${o.value}).`);
      if (o.value !== current.value) overrides.push({ name: o.name, engineValue: current.value, value: o.value });
    }
    if (!overrides.length) return { configuration, overrides: null };
    if ((dto.overrideRationale?.trim().length ?? 0) < 10) throw new BadRequestException('Give a reason (at least 10 characters) for overriding the tuning parameters - it is recorded for audit.');
    return {
      configuration: configuration.map((c) => {
        const o = overrides.find((x) => x.name === c.name);
        return o ? { ...c, value: o.value } : c;
      }),
      overrides,
    };
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<IndexDesign | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async getHistory(projectId: string, requester: AuthenticatedUser): Promise<IndexDesign[]> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /**
   * Resolves the Phase 3 engine's input from the formal Phase 2 -> Phase 3
   * handoff (DataPipelineDesignService.buildPhase3Handoff) rather than reading
   * Discovery/Data Pipeline Design fields directly - a BLOCKED handoff status
   * (either prerequisite phase incomplete) now actually stops Index Design,
   * instead of silently falling back to partial data.
   */
  private async resolveInput(projectId: string, requester: AuthenticatedUser, dto: CreateIndexDesignDto): Promise<IndexDesignInputs> {
    const handoff = await this.dataPipelineDesignService.buildPhase3Handoff(projectId, requester);
    if (handoff.status === 'BLOCKED') {
      throw new BadRequestException(`Cannot run Index Design: ${handoff.statusReasons.join(' ')}`);
    }

    return {
      ...handoff,
      vectorCount: dto.vectorCount ?? handoff.vectorCount,
      dimension: dto.dimension ?? handoff.dimension,
      availableMemoryGb: dto.availableMemoryGb ?? handoff.availableMemoryGb,
      qps: dto.qps ?? Math.max(handoff.qps, handoff.peakQps),
      recallTarget: dto.recallTarget ?? handoff.recallTarget,
      targetP95LatencyMs: dto.targetP95LatencyMs ?? handoff.targetP95LatencyMs,
      topK: dto.topK ?? handoff.topK,
      updateFrequency: dto.updateFrequency,
    };
  }
}
