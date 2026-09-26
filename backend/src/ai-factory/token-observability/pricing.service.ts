import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { PlatformConfigService } from '../../common/config/platform-config.service';
import { InferenceConfigService } from '../../inference/inference-config.service';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiModelPrice } from './model-price.entity';
import { cataloguePrices, costOf, CostBreakdown, planPriceSync, PriceRow, TokenCounts } from './pricing';
import { CreateModelPriceDto } from './dto/create-model-price.dto';

/**
 * Keeps ai_model_prices in step with the price catalogues (spec §13) and
 * answers "what did this cost at that moment". Rows are only ever added or
 * closed, never edited or deleted.
 */
@Injectable()
export class PricingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    private readonly cfg: AiFactoryConfigService,
    private readonly platformConfig: PlatformConfigService,
    private readonly inferenceConfig: InferenceConfigService,
    private readonly projectsService: ProjectsService,
    @InjectRepository(AiModelPrice) private readonly prices: Repository<AiModelPrice>,
  ) {}

  /** Never blocks start-up: a failed sync is logged and retried on the next start. */
  async onApplicationBootstrap() {
    try {
      const { closed, inserted } = await this.syncCatalogue(new Date());
      if (closed || inserted) this.logger.log(`action=price_sync closed=${closed} inserted=${inserted}`);
    } catch (e) {
      this.logger.warn(`Token price sync skipped: ${(e as Error).message}`);
    }
  }

  async syncCatalogue(now: Date): Promise<{ closed: number; inserted: number }> {
    const treatment = this.cfg.getTokenObservabilityCatalogue().pricing;
    const desired = cataloguePrices(this.inferenceConfig.getManagedApiTiers(), this.platformConfig.getEmbeddingProviders(), treatment);
    const existing = (await this.prices.find({ where: { project: IsNull() } })).map((r) => toRow(r, null));
    const plan = planPriceSync(existing, desired, now, new Date(treatment.catalogueEffectiveFrom));
    await this.prices.manager.transaction(async (m) => {
      for (const c of plan.close) await m.update(AiModelPrice, { id: c.id }, { effectiveTo: c.effectiveTo });
      if (plan.insert.length) {
        await m.insert(
          AiModelPrice,
          plan.insert.map((p) => ({ project: null, provider: p.provider, model: p.model, region: p.region ?? null, tokenType: p.tokenType, pricePer1M: p.pricePer1M, currency: p.currency, effectiveFrom: new Date(p.effectiveFrom), effectiveTo: null, source: p.source })),
        );
      }
    });
    return { closed: plan.close.length, inserted: plan.insert.length };
  }

  /** Catalogue rows plus this project's contracted overrides - everything needed to price its usage. */
  async rowsFor(projectId: string): Promise<PriceRow[]> {
    const rows = await this.prices.find({ where: [{ project: IsNull() }, { project: { id: projectId } }], relations: { project: true } });
    return rows.map((r) => toRow(r, r.project?.id ?? null));
  }

  async list(projectId: string, requester: AuthenticatedUser): Promise<PriceRow[]> {
    await this.projectsService.findOne(projectId, requester);
    return (await this.rowsFor(projectId)).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.tokenType.localeCompare(b.tokenType) || a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  }

  /** A contracted price for this project (optionally for one region). Closes the project's open row for the same key and region; the catalogue is untouched. */
  async addProjectPrice(projectId: string, requester: AuthenticatedUser, dto: CreateModelPriceDto): Promise<PriceRow> {
    await this.projectsService.findOne(projectId, requester);
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    const region = dto.region?.trim() || null;
    const key = { provider: dto.provider, model: dto.model, tokenType: dto.tokenType };
    const saved = await this.prices.manager.transaction(async (m) => {
      const open = await m.findOne(AiModelPrice, { where: { ...key, region: region ?? IsNull(), project: { id: projectId }, effectiveTo: IsNull() } });
      if (open) {
        if (effectiveFrom <= open.effectiveFrom) throw new BadRequestException(`A price for this model${region ? ` in ${region}` : ''} starting ${open.effectiveFrom.toISOString()} already exists; a new price must start after it.`);
        await m.update(AiModelPrice, { id: open.id }, { effectiveTo: effectiveFrom });
      }
      return m.save(
        m.create(AiModelPrice, { ...key, region, project: { id: projectId } as Project, pricePer1M: dto.pricePer1M, currency: dto.currency ?? this.cfg.getTokenObservabilityCatalogue().pricing.currency, effectiveFrom, effectiveTo: null, source: dto.source }),
      );
    });
    this.logger.log(`user=${requester.email} action=add_token_price projectId=${projectId} provider=${dto.provider} model=${dto.model} tokenType=${dto.tokenType} region=${region ?? 'any'}`);
    return toRow(saved, projectId);
  }

  /** Cost at the prices in force at `at` (project override first). */
  cost(rows: PriceRow[], provider: string, model: string, tokens: TokenCounts, at: Date, projectId: string, region: string | null = null): CostBreakdown {
    return costOf(rows, provider, model, tokens, at, projectId, this.cfg.getTokenObservabilityCatalogue().pricing, region);
  }
}

function toRow(r: AiModelPrice, projectId: string | null): PriceRow {
  return { id: r.id, projectId, provider: r.provider, model: r.model, region: r.region ?? null, tokenType: r.tokenType, pricePer1M: r.pricePer1M, currency: r.currency, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, source: r.source };
}
