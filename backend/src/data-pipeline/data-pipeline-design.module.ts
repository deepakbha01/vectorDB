import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataPipelineDesign } from './data-pipeline-design.entity';
import { DataPipelineDesignService } from './data-pipeline-design.service';
import { DataPipelineDesignController } from './data-pipeline-design.controller';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { SchemaGeneratorModule } from '../schema-generator/schema-generator.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DataPipelineDesign]),
    ProjectsModule,
    DiscoveryModule,
    EmbeddingsModule,
    SchemaGeneratorModule,
  ],
  providers: [DataPipelineDesignService],
  controllers: [DataPipelineDesignController],
  exports: [DataPipelineDesignService],
})
export class DataPipelineDesignModule {}
