import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexDesign } from './index-design.entity';
import { IndexDesignService } from './index-design.service';
import { IndexDesignController } from './index-design.controller';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { IndexRecommendationEngineModule } from '../index-recommendation-engine/index-recommendation-engine.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([IndexDesign]),
    ProjectsModule,
    DiscoveryModule,
    DataPipelineDesignModule,
    IndexRecommendationEngineModule,
  ],
  providers: [IndexDesignService],
  controllers: [IndexDesignController],
  exports: [IndexDesignService],
})
export class IndexDesignModule {}
