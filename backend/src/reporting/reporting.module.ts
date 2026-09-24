import { Module } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { ReportingController } from './reporting.controller';
import { ReportBuilderService } from './report-builder.service';
import { PdfRendererService } from './pdf-renderer.service';
import { DocxRendererService } from './docx-renderer.service';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { VectorDbSelectionModule } from '../vector-db-selection/vector-db-selection.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { IndexDesignModule } from '../index-design/index-design.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { BenchmarkModule } from '../benchmark/benchmark.module';
import { CapacityPlanningModule } from '../capacity-planning/capacity-planning.module';

@Module({
  imports: [
    ProjectsModule,
    DiscoveryModule,
    VectorDbSelectionModule,
    DataPipelineDesignModule,
    IndexDesignModule,
    DeploymentModule,
    BenchmarkModule,
    CapacityPlanningModule,
  ],
  providers: [ReportingService, ReportBuilderService, PdfRendererService, DocxRendererService],
  controllers: [ReportingController],
})
export class ReportingModule {}
