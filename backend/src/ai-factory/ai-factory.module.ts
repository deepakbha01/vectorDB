import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryAssessment } from '../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../data-pipeline/data-pipeline-design.entity';
import { IndexDesign } from '../index-design/index-design.entity';
import { ArchitectureDecisionRecord } from '../vector-db-selection/architecture-decision-record.entity';
import { DeploymentPlan } from '../deployment/deployment-plan.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { CapacityPlan } from '../capacity-planning/capacity-plan.entity';
import { InferenceAssessment } from '../inference/inference-assessment.entity';
import { AiFactoryStateSnapshot } from './ai-factory-state-snapshot.entity';
import { AiFactoryConfigService } from './ai-factory-config.service';
import { AiFactoryService } from './ai-factory.service';
import { AiFactoryController } from './ai-factory.controller';
import { AiFactoryEnabledGuard } from './ai-factory-enabled.guard';
import { AiWorkloadProfile } from './workload-profile/workload-profile.entity';
import { WorkloadProfileService } from './workload-profile/workload-profile.service';
import { WorkloadProfileController } from './workload-profile/workload-profile.controller';
import { AiModelSelection } from './model-selection/model-selection.entity';
import { ModelSelectionService } from './model-selection/model-selection.service';
import { ModelSelectionController } from './model-selection/model-selection.controller';
import { AiInferenceArchitecture } from './inference-architecture/inference-architecture.entity';
import { InferenceArchitectureService } from './inference-architecture/inference-architecture.service';
import { InferenceArchitectureController } from './inference-architecture/inference-architecture.controller';
import { AiInfrastructureDesign } from './infrastructure/infrastructure.entity';
import { InfrastructureDesignService } from './infrastructure/infrastructure.service';
import { InfrastructureDesignController } from './infrastructure/infrastructure.controller';
import { AiRagAgentDesign } from './rag-agent/rag-agent.entity';
import { RagAgentDesignService } from './rag-agent/rag-agent.service';
import { RagAgentDesignController } from './rag-agent/rag-agent.controller';
import { AiSecurityAssessment } from './security/security.entity';
import { SecurityAssessmentService } from './security/security.service';
import { SecurityAssessmentController } from './security/security.controller';
import { AiPerformanceAssessment } from './performance/performance.entity';
import { PerformanceAssessmentService } from './performance/performance.service';
import { PerformanceAssessmentController } from './performance/performance.controller';
import { AiFinopsAssessment } from './finops/finops.entity';
import { FinopsAssessmentService } from './finops/finops.service';
import { FinopsAssessmentController } from './finops/finops.controller';
import { AiOperationsModel } from './operations/operations.entity';
import { OperationsModelService } from './operations/operations.service';
import { OperationsModelController } from './operations/operations.controller';
import { AiFinalRecommendation } from './final/final.entity';
import { FinalRecommendationService } from './final/final.service';
import { FinalRecommendationController } from './final/final.controller';
import { AiTokenEstimate } from './token-observability/token-estimate.entity';
import { TokenObservabilityService } from './token-observability/token-observability.service';
import { TokenObservabilityController } from './token-observability/token-observability.controller';
import { TokenObservabilityEnabledGuard } from './token-observability/token-observability-enabled.guard';
import { AiModelPrice } from './token-observability/model-price.entity';
import { AiUsageEvent } from './token-observability/usage-event.entity';
import { AiUsageRollup } from './token-observability/usage-rollup.entity';
import { PricingService } from './token-observability/pricing.service';
import { UsageService } from './token-observability/usage.service';
import { SimulationService } from './token-observability/simulation.service';
import { AiSimulationRun } from './token-observability/simulation-run.entity';
import { AiIngestKey } from './token-observability/ingest-key.entity';
import { IngestKeyService } from './token-observability/ingest-key.service';
import { IngestKeyGuard } from './token-observability/ingest-key.guard';
import { ObservabilityIngestController } from './token-observability/observability-ingest.controller';
import { AiTokenAlert } from './token-observability/token-alert.entity';
import { AlertService } from './token-observability/alert.service';
import { AlertSchedulerService } from './token-observability/alert-scheduler.service';
import { UsageReadAuditInterceptor } from './token-observability/usage-read-audit.interceptor';
import { TokenRetentionService } from './token-observability/retention.service';
import { AuditLogEntry } from '../audit/audit-log-entry.entity';
import { IngestionRun } from '../ingestion/ingestion-run.entity';
import { InferenceModule } from '../inference/inference.module';

/**
 * AI Factory foundations (Wave 1), AI Workload Profile (Wave 2), Model
 * Selection (Wave 3), Inference Architecture (Wave 4), Infrastructure
 * (Wave 5), RAG / Agent architecture (Wave 6), Security & Governance
 * (Wave 7), Performance & Benchmark (Wave 8), Cost & FinOps (Wave 9), the
 * Operations model (Wave 10), the Final Recommendation (Wave 11) and Token
 * Observability (Wave 12). Registers repositories for the existing
 * deliverable entities for READ access only; the only tables this module
 * writes are ai_factory_state_snapshots, ai_workload_profiles,
 * ai_model_selections, ai_inference_architectures,
 * ai_infrastructure_designs, ai_rag_agent_designs, ai_security_assessments,
 * ai_performance_assessments, ai_finops_assessments, ai_operations_models,
 * ai_final_recommendations, ai_token_estimates, ai_model_prices,
 * ai_usage_events, ai_usage_rollups, ai_simulation_runs, ai_ingest_keys and
 * ai_token_alerts.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiscoveryAssessment,
      DataPipelineDesign,
      IndexDesign,
      ArchitectureDecisionRecord,
      DeploymentPlan,
      OptimizationReport,
      CapacityPlan,
      InferenceAssessment,
      AiFactoryStateSnapshot,
      AiWorkloadProfile,
      AiModelSelection,
      AiInferenceArchitecture,
      AiInfrastructureDesign,
      AiRagAgentDesign,
      AiSecurityAssessment,
      AiPerformanceAssessment,
      IngestionRun,
      AiFinopsAssessment,
      AiOperationsModel,
      AiFinalRecommendation,
      AiTokenEstimate,
      AiModelPrice,
      AiUsageEvent,
      AiUsageRollup,
      AiSimulationRun,
      AiIngestKey,
      AiTokenAlert,
      AuditLogEntry,
    ]),
    ProjectsModule,
    InferenceModule,
  ],
  providers: [AiFactoryConfigService, AiFactoryService, AiFactoryEnabledGuard, WorkloadProfileService, ModelSelectionService, InferenceArchitectureService, InfrastructureDesignService, RagAgentDesignService, SecurityAssessmentService, PerformanceAssessmentService, FinopsAssessmentService, OperationsModelService, FinalRecommendationService, TokenObservabilityEnabledGuard, TokenObservabilityService, PricingService, UsageService, SimulationService, IngestKeyService, IngestKeyGuard, AlertService, AlertSchedulerService, UsageReadAuditInterceptor, TokenRetentionService],
  controllers: [AiFactoryController, WorkloadProfileController, ModelSelectionController, InferenceArchitectureController, InfrastructureDesignController, RagAgentDesignController, SecurityAssessmentController, PerformanceAssessmentController, FinopsAssessmentController, OperationsModelController, FinalRecommendationController, TokenObservabilityController, ObservabilityIngestController],
  exports: [AiFactoryConfigService],
})
export class AiFactoryModule {}
