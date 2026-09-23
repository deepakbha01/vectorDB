import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { User } from './users/user.entity';
import { Project } from './projects/project.entity';
import { DiscoveryAssessment } from './discovery/discovery-assessment.entity';
import { ArchitectureDecisionRecord } from './vector-db-selection/architecture-decision-record.entity';
import { DataPipelineDesign } from './data-pipeline/data-pipeline-design.entity';
import { IndexDesign } from './index-design/index-design.entity';
import { DeploymentPlan } from './deployment/deployment-plan.entity';
import { IngestionRun } from './ingestion/ingestion-run.entity';
import { DeadLetterRecord } from './ingestion/dead-letter-record.entity';
import { IngestionContentHash } from './ingestion/ingestion-content-hash.entity';
import { OptimizationReport } from './benchmark/optimization-report.entity';
import { CapacityPlan } from './capacity-planning/capacity-plan.entity';
import { AuditLogEntry } from './audit/audit-log-entry.entity';
import { InferenceAssessment } from './inference/inference-assessment.entity';

config();

/**
 * TypeORM CLI data source - used only by `npm run migration:*` (see
 * package.json), never imported by the running application (which builds its
 * connection via ConfigService in app.module.ts instead). Kept as a single
 * source of truth for the entity list so it can't drift from app.module.ts.
 *
 * The app currently runs with `synchronize: true` outside production (see
 * app.module.ts) and has no generated migrations yet - see
 * PRODUCTION_READINESS.md for why: `migration:generate` needs to diff
 * against a real, running database, which this development environment does
 * not have. Once one is available, run:
 *   npm run migration:generate -- src/migrations/Initial
 *   npm run migration:run
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.APP_DB_HOST ?? 'localhost',
  port: Number(process.env.APP_DB_PORT ?? 5432),
  username: process.env.APP_DB_USER ?? 'vector_platform',
  password: process.env.APP_DB_PASSWORD ?? 'change-me',
  database: process.env.APP_DB_NAME ?? 'vector_platform',
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
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});
