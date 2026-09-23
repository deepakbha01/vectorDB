import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PlatformConfigModule } from './common/config/platform-config.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health/health.controller';
import { DatabaseAdaptersModule } from './database-adapters/database-adapters.module';
import { RecommendationEngineModule } from './recommendation-engine/recommendation-engine.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { User } from './users/user.entity';
import { Project } from './projects/project.entity';
import { DiscoveryAssessment } from './discovery/discovery-assessment.entity';
import { VectorDbSelectionModule } from './vector-db-selection/vector-db-selection.module';
import { ArchitectureDecisionRecord } from './vector-db-selection/architecture-decision-record.entity';
import { ChunkingModule } from './chunking/chunking.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { SchemaGeneratorModule } from './schema-generator/schema-generator.module';
import { DataPipelineDesignModule } from './data-pipeline/data-pipeline-design.module';
import { DataPipelineDesign } from './data-pipeline/data-pipeline-design.entity';
import { IndexRecommendationEngineModule } from './index-recommendation-engine/index-recommendation-engine.module';
import { IndexDesignModule } from './index-design/index-design.module';
import { IndexDesign } from './index-design/index-design.entity';
import { DeploymentModule } from './deployment/deployment.module';
import { DeploymentPlan } from './deployment/deployment-plan.entity';
import { IngestionModule } from './ingestion/ingestion.module';
import { IngestionRun } from './ingestion/ingestion-run.entity';
import { DeadLetterRecord } from './ingestion/dead-letter-record.entity';
import { IngestionContentHash } from './ingestion/ingestion-content-hash.entity';
import { BenchmarkModule } from './benchmark/benchmark.module';
import { OptimizationReport } from './benchmark/optimization-report.entity';
import { CapacityPlanningModule } from './capacity-planning/capacity-planning.module';
import { CapacityPlan } from './capacity-planning/capacity-plan.entity';
import { ReportingModule } from './reporting/reporting.module';
import { AuditModule } from './audit/audit.module';
import { AuditLogEntry } from './audit/audit-log-entry.entity';
import { InferenceModule } from './inference/inference.module';
import { InferenceAssessment } from './inference/inference-assessment.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('APP_DB_HOST', 'localhost'),
        port: config.get<number>('APP_DB_PORT', 5432),
        username: config.get('APP_DB_USER', 'vector_platform'),
        password: config.get('APP_DB_PASSWORD', 'change-me'),
        database: config.get('APP_DB_NAME', 'vector_platform'),
        entities: [
          User,
          Project,
          DiscoveryAssessment,
          ArchitectureDecisionRecord,
          DataPipelineDesign,
          IndexDesign,
          DeploymentPlan,
          IngestionRun,
          DeadLetterRecord,
          IngestionContentHash,
          OptimizationReport,
          CapacityPlan,
          AuditLogEntry,
          InferenceAssessment,
        ],
        // Sprint 1 uses schema sync for velocity. Replace with TypeORM migrations
        // before any non-development deployment (see development rule #12).
        synchronize: config.get('NODE_ENV') !== 'production',
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('THROTTLE_TTL_SECONDS', 60) * 1000,
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
      }),
    }),
    PlatformConfigModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    DashboardModule,
    DatabaseAdaptersModule,
    RecommendationEngineModule,
    DiscoveryModule,
    ChunkingModule,
    EmbeddingsModule,
    SchemaGeneratorModule,
    DataPipelineDesignModule,
    IndexRecommendationEngineModule,
    IndexDesignModule,
    VectorDbSelectionModule,
    DeploymentModule,
    IngestionModule,
    BenchmarkModule,
    CapacityPlanningModule,
    ReportingModule,
    AuditModule,
    InferenceModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
