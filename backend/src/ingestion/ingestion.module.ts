import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestionRun } from './ingestion-run.entity';
import { DeadLetterRecord } from './dead-letter-record.entity';
import { IngestionContentHash } from './ingestion-content-hash.entity';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { ProjectsModule } from '../projects/projects.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { ChunkingModule } from '../chunking/chunking.module';
import { EmbeddingClientModule } from '../embedding-client/embedding-client.module';
import { DatabaseAdaptersModule } from '../database-adapters/database-adapters.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestionRun, DeadLetterRecord, IngestionContentHash]),
    ProjectsModule,
    DataPipelineDesignModule,
    ChunkingModule,
    EmbeddingClientModule,
    DatabaseAdaptersModule,
  ],
  providers: [IngestionService],
  controllers: [IngestionController],
  exports: [IngestionService],
})
export class IngestionModule {}
