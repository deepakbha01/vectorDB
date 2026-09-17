import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

/**
 * Loads all engine configuration (thresholds, database catalog, embedding catalog,
 * index catalog, infrastructure sizing) from YAML files on disk.
 *
 * Per the platform's configuration-driven design rule, no engine may hard-code
 * thresholds, model names, index parameters, or infrastructure sizes - everything
 * flows through this service so it can be swapped per-environment/customer.
 */
@Injectable()
export class PlatformConfigService implements OnModuleInit {
  private thresholds: Record<string, any> = {};
  private databases: Record<string, any> = {};
  private embeddings: Record<string, any> = {};
  private indexes: Record<string, any> = {};
  private infrastructure: Record<string, any> = {};

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.thresholds = this.load('THRESHOLDS_CONFIG_PATH', './config/thresholds.yaml');
    this.databases = this.load('DATABASES_CONFIG_PATH', './config/databases.yaml');
    this.embeddings = this.load('EMBEDDINGS_CONFIG_PATH', './config/embeddings.yaml');
    this.indexes = this.load('INDEXES_CONFIG_PATH', './config/indexes.yaml');
    this.infrastructure = this.load('INFRASTRUCTURE_CONFIG_PATH', './config/infrastructure.yaml');
  }

  private load(envKey: string, defaultPath: string): Record<string, any> {
    const path = this.config.get<string>(envKey) ?? defaultPath;
    const raw = fs.readFileSync(path, 'utf8');
    return (yaml.load(raw) as Record<string, any>) ?? {};
  }

  getThresholds(): Record<string, any> {
    return this.thresholds;
  }

  getRulesVersion(): string {
    return this.thresholds.rulesVersion ?? 'unknown';
  }

  getSupportedPlatforms(): Array<Record<string, any>> {
    return this.databases.platforms ?? [];
  }

  getEmbeddingProviders(): Array<Record<string, any>> {
    return this.embeddings.providers ?? [];
  }

  getIndexCatalog(): Array<Record<string, any>> {
    return this.indexes.indexes ?? [];
  }

  getInfrastructureProfiles(): Array<Record<string, any>> {
    return this.infrastructure.sizingProfiles ?? [];
  }

  getPipelineDefaults(): Record<string, any> {
    return this.thresholds.pipelineDefaults ?? {};
  }

  getBenchmarkDefaults(): Record<string, any> {
    return this.thresholds.benchmarkDefaults ?? {};
  }

  getCapacityPlanningDefaults(): Record<string, any> {
    return this.thresholds.capacityPlanning ?? {};
  }
}
