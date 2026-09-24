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

/**
 * AI Factory foundations (Wave 1), AI Workload Profile (Wave 2), Model
 * Selection (Wave 3) and Inference Architecture (Wave 4). Registers repositories for the existing
 * deliverable entities for READ access only; the only tables this module
 * writes are ai_factory_state_snapshots, ai_workload_profiles,
 * ai_model_selections and ai_inference_architectures.
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
    ]),
    ProjectsModule,
  ],
  providers: [AiFactoryConfigService, AiFactoryService, AiFactoryEnabledGuard, WorkloadProfileService, ModelSelectionService, InferenceArchitectureService],
  controllers: [AiFactoryController, WorkloadProfileController, ModelSelectionController, InferenceArchitectureController],
  exports: [AiFactoryConfigService],
})
export class AiFactoryModule {}
