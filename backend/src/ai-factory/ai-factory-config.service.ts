import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { PhaseDefinition, PhaseKey, StepDefinition } from './ai-factory.types';
import { WorkloadProfileRules } from './workload-profile/workload-profile.engine';

/**
 * Loads config/ai-factory.yaml (dependency graph, parameter impact map,
 * guided steps). Separate from PlatformConfigService so the vector engines'
 * configuration is untouched.
 */
@Injectable()
export class AiFactoryConfigService implements OnModuleInit {
  private cfg: Record<string, any> = {};

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>('AI_FACTORY_CONFIG_PATH') ?? './config/ai-factory.yaml';
    this.cfg = (yaml.load(fs.readFileSync(path, 'utf8')) as Record<string, any>) ?? {};
  }

  /** Test seam. */
  setConfig(cfg: Record<string, any>) {
    this.cfg = cfg;
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
