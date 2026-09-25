import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { PhaseDefinition, PhaseKey, StepDefinition } from './ai-factory.types';
import { WorkloadProfileRules } from './workload-profile/workload-profile.engine';
import { ModelCatalogue } from './model-selection/model-selection.types';
import { EmbeddingEligibilityRules, IndexEligibilityRules } from './eligibility/eligibility.rules';
import { ServingCatalogue } from './inference-architecture/inference-architecture.types';
import { InfrastructureCatalogue } from './infrastructure/infrastructure.types';
import { RagAgentCatalogue } from './rag-agent/rag-agent.types';
import { SecurityCatalogue } from './security/security.types';
import { PerformanceCatalogue } from './performance/performance.types';
import { FinopsCatalogue } from './finops/finops.types';
import { OperationsCatalogue } from './operations/operations.types';
import { TokenObservabilityCatalogue } from './token-observability/token-observability.types';

/**
 * Loads config/ai-factory.yaml (dependency graph, parameter impact map,
 * guided steps, workload-profile and eligibility rules), config/models.yaml
 * (model catalogue), config/serving.yaml (serving options) and
 * config/infrastructure-targets.yaml (deployment targets) and
 * config/rag-agent.yaml (RAG / agent patterns) and
 * config/security-governance.yaml (policy rules and control areas) and
 * config/performance.yaml (benchmark metrics and assumed targets) and
 * config/finops.yaml (directional unit rates) and
 * config/operations.yaml (availability, recovery and operational-load rules) and
 * config/token-observability.yaml (pricing treatment, estimation assumptions). Separate from
 * PlatformConfigService so the vector engines' configuration is untouched.
 */
@Injectable()
export class AiFactoryConfigService implements OnModuleInit {
  private cfg: Record<string, any> = {};
  private models: ModelCatalogue = {} as ModelCatalogue;
  private serving: ServingCatalogue = {} as ServingCatalogue;
  private infrastructure: InfrastructureCatalogue = {} as InfrastructureCatalogue;
  private ragAgent: RagAgentCatalogue = {} as RagAgentCatalogue;
  private security: SecurityCatalogue = {} as SecurityCatalogue;
  private performance: PerformanceCatalogue = {} as PerformanceCatalogue;
  private finops: FinopsCatalogue = {} as FinopsCatalogue;
  private operations: OperationsCatalogue = {} as OperationsCatalogue;
  private tokenObservability: TokenObservabilityCatalogue = {} as TokenObservabilityCatalogue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>('AI_FACTORY_CONFIG_PATH') ?? './config/ai-factory.yaml';
    this.cfg = (yaml.load(fs.readFileSync(path, 'utf8')) as Record<string, any>) ?? {};
    const modelsPath = this.config.get<string>('AI_FACTORY_MODELS_CONFIG_PATH') ?? './config/models.yaml';
    this.models = yaml.load(fs.readFileSync(modelsPath, 'utf8')) as ModelCatalogue;
    const servingPath = this.config.get<string>('AI_FACTORY_SERVING_CONFIG_PATH') ?? './config/serving.yaml';
    this.serving = yaml.load(fs.readFileSync(servingPath, 'utf8')) as ServingCatalogue;
    const infraPath = this.config.get<string>('AI_FACTORY_INFRASTRUCTURE_CONFIG_PATH') ?? './config/infrastructure-targets.yaml';
    this.infrastructure = yaml.load(fs.readFileSync(infraPath, 'utf8')) as InfrastructureCatalogue;
    const ragAgentPath = this.config.get<string>('AI_FACTORY_RAG_AGENT_CONFIG_PATH') ?? './config/rag-agent.yaml';
    this.ragAgent = yaml.load(fs.readFileSync(ragAgentPath, 'utf8')) as RagAgentCatalogue;
    const securityPath = this.config.get<string>('AI_FACTORY_SECURITY_CONFIG_PATH') ?? './config/security-governance.yaml';
    this.security = yaml.load(fs.readFileSync(securityPath, 'utf8')) as SecurityCatalogue;
    const performancePath = this.config.get<string>('AI_FACTORY_PERFORMANCE_CONFIG_PATH') ?? './config/performance.yaml';
    this.performance = yaml.load(fs.readFileSync(performancePath, 'utf8')) as PerformanceCatalogue;
    const finopsPath = this.config.get<string>('AI_FACTORY_FINOPS_CONFIG_PATH') ?? './config/finops.yaml';
    this.finops = yaml.load(fs.readFileSync(finopsPath, 'utf8')) as FinopsCatalogue;
    const operationsPath = this.config.get<string>('AI_FACTORY_OPERATIONS_CONFIG_PATH') ?? './config/operations.yaml';
    this.operations = yaml.load(fs.readFileSync(operationsPath, 'utf8')) as OperationsCatalogue;
    const tokenPath = this.config.get<string>('TOKEN_OBSERVABILITY_CONFIG_PATH') ?? './config/token-observability.yaml';
    this.tokenObservability = yaml.load(fs.readFileSync(tokenPath, 'utf8')) as TokenObservabilityCatalogue;
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

  setServingCatalogue(serving: ServingCatalogue) {
    this.serving = serving;
  }

  getServingCatalogue(): ServingCatalogue {
    return this.serving;
  }

  setInfrastructureCatalogue(infrastructure: InfrastructureCatalogue) {
    this.infrastructure = infrastructure;
  }

  getInfrastructureCatalogue(): InfrastructureCatalogue {
    return this.infrastructure;
  }

  setRagAgentCatalogue(ragAgent: RagAgentCatalogue) {
    this.ragAgent = ragAgent;
  }

  getRagAgentCatalogue(): RagAgentCatalogue {
    return this.ragAgent;
  }

  setSecurityCatalogue(security: SecurityCatalogue) {
    this.security = security;
  }

  getSecurityCatalogue(): SecurityCatalogue {
    return this.security;
  }

  setPerformanceCatalogue(performance: PerformanceCatalogue) {
    this.performance = performance;
  }

  getPerformanceCatalogue(): PerformanceCatalogue {
    return this.performance;
  }

  setFinopsCatalogue(finops: FinopsCatalogue) {
    this.finops = finops;
  }

  getFinopsCatalogue(): FinopsCatalogue {
    return this.finops;
  }

  setOperationsCatalogue(operations: OperationsCatalogue) {
    this.operations = operations;
  }

  getOperationsCatalogue(): OperationsCatalogue {
    return this.operations;
  }

  setTokenObservabilityCatalogue(tokenObservability: TokenObservabilityCatalogue) {
    this.tokenObservability = tokenObservability;
  }

  getTokenObservabilityCatalogue(): TokenObservabilityCatalogue {
    return this.tokenObservability;
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
