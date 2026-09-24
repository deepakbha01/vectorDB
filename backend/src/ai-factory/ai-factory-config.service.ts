import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { PhaseDefinition, PhaseKey, StepDefinition } from './ai-factory.types';
import { WorkloadProfileRules } from './workload-profile/workload-profile.engine';
import { ModelCatalogue } from './model-selection/model-selection.types';
import { EmbeddingEligibilityRules, IndexEligibilityRules } from './eligibility/eligibility.rules';

/**
 * Loads config/ai-factory.yaml (dependency graph, parameter impact map,
 * guided steps, workload-profile and eligibility rules) and
 * config/models.yaml (model catalogue). Separate from PlatformConfigService
 * so the vector engines' configuration is untouched.
 */
@Injectable()
export class AiFactoryConfigService implements OnModuleInit {
  private cfg: Record<string, any> = {};
  private models: ModelCatalogue = {} as ModelCatalogue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>('AI_FACTORY_CONFIG_PATH') ?? './config/ai-factory.yaml';
    this.cfg = (yaml.load(fs.readFileSync(path, 'utf8')) as Record<string, any>) ?? {};
    const modelsPath = this.config.get<string>('AI_FACTORY_MODELS_CONFIG_PATH') ?? './config/models.yaml';
    this.models = yaml.load(fs.readFileSync(modelsPath, 'utf8')) as ModelCatalogue;
  }

  /** Test seams. */
  setConfig(cfg: Record<string, any>) {
    this.cfg = cfg;
  }

  setModelCatalogue(models: ModelCatalogue) {
    this.models = models;
  }

  getModelCatalogue(): ModelCatalogue {
    return this.models;
  }

  getIndexEligibilityRules(): IndexEligibilityRules {
    return this.cfg.indexEligibility;
  }

  getEmbeddingEligibilityRules(): EmbeddingEligibilityRules {
    return this.cfg.embeddingEligibility;
  }

  getRulesVersion(): string {
    return this.cfg.rulesVersion ?? 'unknown';
  }

  getPhases(): PhaseDefinition[] {
    return this.cfg.phases ?? [];
  }

  getPhase(key: PhaseKey): PhaseDefinition | undefined {
    return this.getPhases().find((p) => p.key === key);
  }

  getSteps(): StepDefinition[] {
    return this.cfg.steps ?? [];
  }

  getWorkloadProfileRules(): WorkloadProfileRules {
    return this.cfg.workloadProfile;
  }

  /** Discovery field → phases that read it directly ([] for fields reviewed as driving no decision). */
  getParameterImpact(): Record<string, PhaseKey[]> {
    const raw: Record<string, PhaseKey[] | 'none'> = this.cfg.parameterImpact ?? {};
    return Object.fromEntries(Object.entries(raw).map(([field, phases]) => [field, phases === 'none' ? [] : phases]));
  }
}
