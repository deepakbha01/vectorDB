import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArchitectureDecisionRecord } from './architecture-decision-record.entity';
import { VectorDbSelectionService } from './vector-db-selection.service';
import { VectorDbSelectionController } from './vector-db-selection.controller';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { IndexDesignModule } from '../index-design/index-design.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ArchitectureDecisionRecord]),
    ProjectsModule,
    DiscoveryModule,
    DataPipelineDesignModule,
    IndexDesignModule,
    RecommendationEngineModule,
  ],
  providers: [VectorDbSelectionService],
  controllers: [VectorDbSelectionController],
  exports: [VectorDbSelectionService],
})
export class VectorDbSelectionModule {}
