import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InferenceAssessment } from './inference-assessment.entity';
import { InferenceConfigService } from './inference-config.service';
import { InferenceEngineService } from './inference-engine.service';
import { InferenceService } from './inference.service';
import { InferenceController } from './inference.controller';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { PdfRendererService } from '../reporting/pdf-renderer.service';
import { DocxRendererService } from '../reporting/docx-renderer.service';

/**
 * Inference-as-a-Service assessment track. Self-contained: own config file,
 * own table, own routes. Reads the vector track (Discovery, Data Pipeline)
 * only to suggest defaults, and reuses the stateless report renderers.
 */
@Module({
  imports: [TypeOrmModule.forFeature([InferenceAssessment]), ProjectsModule, DiscoveryModule, DataPipelineDesignModule],
  providers: [InferenceConfigService, InferenceEngineService, InferenceService, PdfRendererService, DocxRendererService],
  controllers: [InferenceController],
  exports: [InferenceService, InferenceEngineService],
})
export class InferenceModule {}
