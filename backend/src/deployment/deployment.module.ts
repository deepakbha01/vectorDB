import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeploymentPlan } from './deployment-plan.entity';
import { DeploymentPlanService } from './deployment-plan.service';
import { DeploymentPlanController } from './deployment-plan.controller';
import { IacGeneratorService } from './iac-generator.service';
import { ProjectsModule } from '../projects/projects.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { IndexDesignModule } from '../index-design/index-design.module';
import { SchemaGeneratorModule } from '../schema-generator/schema-generator.module';
import { DatabaseAdaptersModule } from '../database-adapters/database-adapters.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeploymentPlan]),
    ProjectsModule,
    DataPipelineDesignModule,
    IndexDesignModule,
    SchemaGeneratorModule,
    DatabaseAdaptersModule,
  ],
  providers: [DeploymentPlanService, IacGeneratorService],
  controllers: [DeploymentPlanController],
  exports: [DeploymentPlanService],
})
export class DeploymentModule {}
