import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntry } from '../audit/audit-log-entry.entity';
import { ProjectsModule } from '../projects/projects.module';
import { DatabaseAdaptersModule } from '../database-adapters/database-adapters.module';
import { DataPipelineDesignModule } from '../data-pipeline/data-pipeline-design.module';
import { IndexDesignModule } from '../index-design/index-design.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { EmbeddingClientModule } from '../embedding-client/embedding-client.module';
import { DataExplorerController } from './data-explorer.controller';
import { DataExplorerService } from './data-explorer.service';
import { DataExplorerEnabledGuard } from './data-explorer-enabled.guard';
import { DataExplorerReadAuditInterceptor } from './data-explorer-read-audit.interceptor';

/** Data Explorer (phase 1) - read-only exploration of the project's target vector database. Behind DATA_EXPLORER_ENABLED. */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntry]), ProjectsModule, DatabaseAdaptersModule, DataPipelineDesignModule, IndexDesignModule, DiscoveryModule, EmbeddingClientModule],
  controllers: [DataExplorerController],
  providers: [DataExplorerService, DataExplorerEnabledGuard, DataExplorerReadAuditInterceptor],
})
export class DataExplorerModule {}
