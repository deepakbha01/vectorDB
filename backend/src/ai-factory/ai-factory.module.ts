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

/**
 * AI Factory foundations (Wave 1) and AI Workload Profile (Wave 2). Registers repositories for the existing
 * deliverable entities for READ access only; the only tables this module
 * writes are ai_factory_state_snapshots and ai_workload_profiles.
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
    ]),
    ProjectsModule,
  ],
  providers: [AiFactoryConfigService, AiFactoryService, AiFactoryEnabledGuard, WorkloadProfileService],
  controllers: [AiFactoryController, WorkloadProfileController],
  exports: [AiFactoryConfigService],
})
export class AiFactoryModule {}
