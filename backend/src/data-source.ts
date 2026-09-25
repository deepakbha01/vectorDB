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
import { AiFactoryStateSnapshot } from './ai-factory/ai-factory-state-snapshot.entity';
import { AiWorkloadProfile } from './ai-factory/workload-profile/workload-profile.entity';
import { AiModelSelection } from './ai-factory/model-selection/model-selection.entity';
import { AiInferenceArchitecture } from './ai-factory/inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from './ai-factory/infrastructure/infrastructure.entity';
import { AiRagAgentDesign } from './ai-factory/rag-agent/rag-agent.entity';
import { AiSecurityAssessment } from './ai-factory/security/security.entity';
import { AiPerformanceAssessment } from './ai-factory/performance/performance.entity';
import { AiFinopsAssessment } from './ai-factory/finops/finops.entity';
import { AiOperationsModel } from './ai-factory/operations/operations.entity';
import { AiFinalRecommendation } from './ai-factory/final/final.entity';
import { AiTokenEstimate } from './ai-factory/token-observability/token-estimate.entity';
import { AiModelPrice } from './ai-factory/token-observability/model-price.entity';
import { AiUsageEvent } from './ai-factory/token-observability/usage-event.entity';
import { AiUsageRollup } from './ai-factory/token-observability/usage-rollup.entity';
import { AiSimulationRun } from './ai-factory/token-observability/simulation-run.entity';

config();

/**
 * TypeORM CLI data source - used only by `npm run migration:*` (see
 * package.json), never imported by the running application (which builds its
 * connection via ConfigService in app.module.ts instead). Kept as a single
 * source of truth for the entity list so it can't drift from app.module.ts.
 *
 * The app runs with `synchronize: true` outside production (see
 * app.module.ts). Production applies src/migrations instead - the baseline
 * is *-InitialSchema.ts (safe on synchronize-created databases; see its
 * header). For schema changes after the baseline:
 *   npm run migration:generate -- src/migrations/<Name>
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
    AiFactoryStateSnapshot,
    AiWorkloadProfile,
    AiModelSelection,
    AiInferenceArchitecture,
    AiInfrastructureDesign,
    AiRagAgentDesign,
    AiSecurityAssessment,
    AiPerformanceAssessment,
    AiFinopsAssessment,
    AiOperationsModel,
    AiFinalRecommendation,
    AiTokenEstimate,
    AiModelPrice,
    AiUsageEvent,
    AiUsageRollup,
    AiSimulationRun,
  ],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});
