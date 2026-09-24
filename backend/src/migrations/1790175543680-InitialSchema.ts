import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline schema (AI Factory Wave 0). Creates every table the application
 * currently defines, so production can run with `synchronize: false` and
 * `npm run migration:run` instead of TypeORM schema sync.
 *
 * Generated from the entity metadata by TypeORM's schema builder against an
 * empty scratch schema, then verified by applying it to a second empty schema
 * and confirming TypeORM reports zero remaining differences.
 *
 * EXISTING DATABASES: environments created earlier by `synchronize: true`
 * (e.g. local development) already have these tables. up() detects that and
 * only records this migration as applied, changing nothing - so running
 * `npm run migration:run` there is safe.
 *
 * The uuid-ossp extension used for uuid primary keys is created by TypeORM's
 * Postgres driver on connect (CREATE EXTENSION IF NOT EXISTS), not here.
 */
export class InitialSchema1790175543680 implements MigrationInterface {
    name = 'InitialSchema1790175543680';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('projects')) {
            // Schema already created by `synchronize: true` - baseline only.
            return;
        }
        await queryRunner.query(`CREATE TYPE "users_role_enum" AS ENUM('admin', 'architect', 'viewer')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "fullName" character varying, "role" "users_role_enum" NOT NULL DEFAULT 'viewer', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "projects_customermode_enum" AS ENUM('new', 'existing')`);
        await queryRunner.query(`CREATE TYPE "projects_platform_enum" AS ENUM('undetermined', 'oracle', 'postgres_pgvector', 'milvus', 'pinecone', 'qdrant', 'weaviate', 'chroma', 'elasticsearch', 'redis', 'mongodb_atlas', 'lancedb', 'actian')`);
        await queryRunner.query(`CREATE TABLE "projects" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "businessUseCase" character varying, "industry" character varying, "patternId" character varying, "customerMode" "projects_customermode_enum" NOT NULL DEFAULT 'new', "platform" "projects_platform_enum" NOT NULL DEFAULT 'undetermined', "platformIsManualOverride" boolean NOT NULL DEFAULT false, "platformDecisionRationale" character varying, "phaseStatuses" jsonb NOT NULL DEFAULT '{"discovery":"not_started","data_embeddings":"not_started","index_design":"not_started","vector_db_selection":"not_started","infrastructure":"not_started","ingestion":"not_started","optimization":"not_started","capacity":"not_started"}', "assessmentVersion" integer NOT NULL DEFAULT '1', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_environment_enum" AS ENUM('development', 'staging', 'production')`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_similaritymetric_enum" AS ENUM('cosine', 'dot_product', 'euclidean')`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_qpsscope_enum" AS ENUM('aggregate', 'per_region', 'per_index')`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_deploymentenvironment_enum" AS ENUM('cloud', 'on_premises', 'hybrid')`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_operationalcapability_enum" AS ENUM('none', 'part_time', 'dedicated_dba', 'platform_team')`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_datareplicationmodel_enum" AS ENUM('none', 'active_passive', 'active_active')`);
        await queryRunner.query(`CREATE TYPE "discovery_assessments_tenancymodel_enum" AS ENUM('single_tenant', 'shared_multi_tenant', 'dedicated_per_tenant')`);
        await queryRunner.query(`CREATE TABLE "discovery_assessments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "environment" "discovery_assessments_environment_enum" NOT NULL, "documentCount" integer NOT NULL, "documentGrowthPercentPerMonth" double precision NOT NULL, "avgDocumentSizeKb" double precision NOT NULL, "chunksPerDocument" integer NOT NULL, "estimatedVectorCount" integer NOT NULL, "embeddingDimension" integer NOT NULL, "similarityMetric" "discovery_assessments_similaritymetric_enum" NOT NULL DEFAULT 'cosine', "qps" double precision NOT NULL, "peakQps" double precision NOT NULL, "qpsScope" "discovery_assessments_qpsscope_enum" NOT NULL DEFAULT 'aggregate', "concurrentUsers" integer NOT NULL, "targetP95LatencyMs" double precision NOT NULL, "targetP99LatencyMs" double precision NOT NULL DEFAULT '0', "availabilityTargetPercent" double precision NOT NULL, "rpoMinutes" integer NOT NULL, "rtoMinutes" integer NOT NULL, "retentionDays" integer NOT NULL, "requiresSimilaritySearch" boolean NOT NULL, "requiresSemanticSearch" boolean NOT NULL, "requiresHybridSearch" boolean NOT NULL, "requiresMetadataFiltering" boolean NOT NULL, "requiresFullTextSearch" boolean NOT NULL, "topK" integer NOT NULL, "recallTarget" double precision NOT NULL, "precisionTarget" double precision, "requiresReranking" boolean NOT NULL DEFAULT false, "ndcgTarget" double precision, "mrrTarget" double precision, "hasExistingOracle" boolean NOT NULL, "hasExistingPostgres" boolean NOT NULL, "hasExistingKubernetes" boolean NOT NULL, "existingPlatforms" jsonb NOT NULL DEFAULT '[]', "deploymentEnvironment" "discovery_assessments_deploymentenvironment_enum" NOT NULL, "availableCpuCores" double precision NOT NULL, "availableRamGb" double precision NOT NULL, "availableStorageGb" double precision NOT NULL, "hasGpu" boolean NOT NULL, "operationalCapability" "discovery_assessments_operationalcapability_enum" NOT NULL DEFAULT 'none', "monthlyBudgetUsd" double precision, "requiresMultiRegion" boolean NOT NULL DEFAULT false, "deploymentRegionCount" integer, "trafficDistributionPercent" character varying, "dataReplicationModel" "discovery_assessments_datareplicationmodel_enum" NOT NULL DEFAULT 'none', "regionalFailoverRequired" boolean NOT NULL DEFAULT false, "crossRegionReplicationRequired" boolean NOT NULL DEFAULT false, "tenancyModel" "discovery_assessments_tenancymodel_enum" NOT NULL DEFAULT 'single_tenant', "requiresAuthentication" boolean NOT NULL, "requiresRbac" boolean NOT NULL, "requiresEncryptionAtRest" boolean NOT NULL, "requiresEncryptionInTransit" boolean NOT NULL, "requiresKeyManagement" boolean NOT NULL DEFAULT false, "requiresTenantIsolation" boolean NOT NULL DEFAULT false, "requiresAuditLogging" boolean NOT NULL DEFAULT false, "dataResidencyRequirement" character varying, "containsPii" boolean NOT NULL, "regulatoryRequirements" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "submittedById" uuid, CONSTRAINT "PK_b3addf7d73921d0fb940f53a74f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_953703a5b5478a041c3a53558a" ON "discovery_assessments" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "architecture_decision_records_decision_enum" AS ENUM('undetermined', 'oracle', 'postgres_pgvector', 'milvus', 'pinecone', 'qdrant', 'weaviate', 'chroma', 'elasticsearch', 'redis', 'mongodb_atlas', 'lancedb', 'actian')`);
        await queryRunner.query(`CREATE TYPE "architecture_decision_records_decisionstatus_enum" AS ENUM('single', 'tied', 'conditional')`);
        await queryRunner.query(`CREATE TYPE "architecture_decision_records_confidence_enum" AS ENUM('high', 'medium', 'low')`);
        await queryRunner.query(`CREATE TABLE "architecture_decision_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rulesVersion" character varying NOT NULL, "decision" "architecture_decision_records_decision_enum" NOT NULL, "rationale" text NOT NULL, "options" jsonb NOT NULL, "rejectedAlternatives" jsonb NOT NULL, "assumptions" jsonb NOT NULL, "risks" jsonb NOT NULL, "infrastructureEstimate" jsonb NOT NULL, "operationalComplexity" character varying NOT NULL, "plainLanguageSummary" jsonb, "criteriaWeights" jsonb, "decisionStatus" "architecture_decision_records_decisionstatus_enum" NOT NULL DEFAULT 'single', "confidence" "architecture_decision_records_confidence_enum" NOT NULL DEFAULT 'high', "tiedPlatformIds" jsonb NOT NULL DEFAULT '[]', "tieBreakStage" text, "openValidations" jsonb NOT NULL DEFAULT '[]', "budgetFeasibility" jsonb, "complianceGate" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "assessmentId" uuid, CONSTRAINT "REL_67081adccebd48b61618e28768" UNIQUE ("assessmentId"), CONSTRAINT "PK_c6c449ad2f8e73443131df0c97d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_83f51e0c4db1b234f4898b80bb" ON "architecture_decision_records" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "data_pipeline_designs_chunkingstrategy_enum" AS ENUM('fixed_size', 'token_based', 'sentence_based', 'paragraph_based', 'recursive', 'semantic', 'sliding_window')`);
        await queryRunner.query(`CREATE TYPE "data_pipeline_designs_similaritymetric_enum" AS ENUM('cosine', 'dot_product', 'euclidean')`);
        await queryRunner.query(`CREATE TYPE "data_pipeline_designs_dimensionmismatchreason_enum" AS ENUM('model_quality_requirement', 'model_migration', 'benchmark_result', 'customer_requirement', 'other')`);
        await queryRunner.query(`CREATE TABLE "data_pipeline_designs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "collectionName" character varying NOT NULL, "chunkingStrategy" "data_pipeline_designs_chunkingstrategy_enum" NOT NULL, "chunkSize" integer NOT NULL, "chunkOverlap" integer NOT NULL, "minChunkSize" integer, "maxChunkSize" integer, "embeddingProviderId" character varying NOT NULL, "embeddingModelId" character varying NOT NULL, "embeddingDimension" integer NOT NULL, "similarityMetric" "data_pipeline_designs_similaritymetric_enum" NOT NULL DEFAULT 'cosine', "dimensionMismatchReason" "data_pipeline_designs_dimensionmismatchreason_enum", "maxInputTokens" integer NOT NULL, "costPerMillionTokens" double precision NOT NULL, "languageSupport" jsonb NOT NULL, "qualityTier" character varying NOT NULL, "modelVersion" character varying NOT NULL, "metadataFields" jsonb NOT NULL, "generatedSchemas" jsonb NOT NULL, "pipelineStages" jsonb NOT NULL, "errorHandling" jsonb NOT NULL, "validationWarnings" jsonb NOT NULL, "executiveSummary" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_8a7f664e3993d9203c350a36a4c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dcd013dc4df2e7dfbe6b9a5978" ON "data_pipeline_designs" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "index_designs_decision_enum" AS ENUM('hnsw', 'ivf_flat', 'pq')`);
        await queryRunner.query(`CREATE TYPE "index_designs_updatefrequency_enum" AS ENUM('static', 'low', 'moderate', 'high')`);
        await queryRunner.query(`CREATE TABLE "index_designs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "rulesVersion" character varying NOT NULL, "decision" "index_designs_decision_enum" NOT NULL, "label" character varying NOT NULL, "rationale" text NOT NULL, "configuration" jsonb NOT NULL, "impact" jsonb NOT NULL, "scalingConsiderations" jsonb NOT NULL, "options" jsonb NOT NULL, "criteriaWeights" jsonb, "alternatives" jsonb NOT NULL, "updateFrequency" "index_designs_updatefrequency_enum" NOT NULL, "inputsUsed" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_8d55c7b78dfde768907fbe56f10" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_11febf7323f8774a2e95c7fd95" ON "index_designs" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "deployment_plans_platform_enum" AS ENUM('undetermined', 'oracle', 'postgres_pgvector', 'milvus', 'pinecone', 'qdrant', 'weaviate', 'chroma', 'elasticsearch', 'redis', 'mongodb_atlas', 'lancedb', 'actian')`);
        await queryRunner.query(`CREATE TABLE "deployment_plans" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "platform" "deployment_plans_platform_enum" NOT NULL, "collectionName" character varying NOT NULL, "sqlScript" text NOT NULL, "terraform" text NOT NULL, "kubernetesArtifacts" jsonb, "healthCheck" jsonb NOT NULL, "deploymentChecklist" jsonb NOT NULL, "rollbackProcedure" jsonb NOT NULL, "executed" boolean NOT NULL DEFAULT false, "executedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_2a947e825f567cc0f191dd5d391" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7bbec6114e03c6f932308b2f3c" ON "deployment_plans" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "ingestion_runs_status_enum" AS ENUM('completed', 'completed_with_errors', 'failed')`);
        await queryRunner.query(`CREATE TABLE "ingestion_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "status" "ingestion_runs_status_enum" NOT NULL, "collectionName" character varying NOT NULL, "configUsed" jsonb NOT NULL, "metrics" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_e9476c02c52a0dac026b859858a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3c1389dcbebdfc4022f9307f7d" ON "ingestion_runs" ("projectId") `);
        await queryRunner.query(`CREATE TABLE "dead_letter_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "documentId" character varying, "chunkIndex" integer, "reason" text NOT NULL, "payloadSnapshot" jsonb NOT NULL, "reprocessed" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "ingestionRunId" uuid, CONSTRAINT "PK_89063bd64e4000fbf59a3d47649" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f05629992c8093aeb9c6b95aaf" ON "dead_letter_records" ("ingestionRunId") `);
        await queryRunner.query(`CREATE TABLE "ingestion_content_hashes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "collectionName" character varying NOT NULL, "contentHash" character varying NOT NULL, "recordId" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, CONSTRAINT "UQ_d6070721ca92c1eceb3b868ee99" UNIQUE ("projectId", "collectionName", "contentHash"), CONSTRAINT "PK_8cadccd820ace5d6fb31f9a1553" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f02a0f233f2d7e8625e99c2b3e" ON "ingestion_content_hashes" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "optimization_reports_indextype_enum" AS ENUM('hnsw', 'ivf_flat', 'pq')`);
        await queryRunner.query(`CREATE TABLE "optimization_reports" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "indexType" "optimization_reports_indextype_enum" NOT NULL, "baselineConfiguration" jsonb NOT NULL, "sampleSize" integer NOT NULL, "queryCount" integer NOT NULL, "topK" integer NOT NULL, "variantResults" jsonb NOT NULL, "recommendedVariant" jsonb NOT NULL, "bottlenecks" jsonb NOT NULL, "beforeAfterComparison" jsonb NOT NULL, "capacityImpact" jsonb NOT NULL, "costImplications" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_b7af6960457ba3ab97404eae0c5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_34519804e4ae80abefc8f27a49" ON "optimization_reports" ("projectId") `);
        await queryRunner.query(`CREATE TYPE "capacity_plans_platform_enum" AS ENUM('undetermined', 'oracle', 'postgres_pgvector', 'milvus', 'pinecone', 'qdrant', 'weaviate', 'chroma', 'elasticsearch', 'redis', 'mongodb_atlas', 'lancedb', 'actian')`);
        await queryRunner.query(`CREATE TYPE "capacity_plans_indextype_enum" AS ENUM('hnsw', 'ivf_flat', 'pq')`);
        await queryRunner.query(`CREATE TABLE "capacity_plans" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "platform" "capacity_plans_platform_enum" NOT NULL, "indexType" "capacity_plans_indextype_enum" NOT NULL, "inputsUsed" jsonb NOT NULL, "currentState" jsonb NOT NULL, "forecast" jsonb NOT NULL, "shardingRecommendation" jsonb NOT NULL, "haRecommendation" jsonb NOT NULL, "drRecommendation" jsonb NOT NULL, "recommendedInfrastructure" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_29f311c0bc1f9ea60eaf4066981" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_541f581d35eacdc5d4b3cae1a3" ON "capacity_plans" ("projectId") `);
        await queryRunner.query(`CREATE TABLE "audit_log_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userEmail" character varying, "method" character varying NOT NULL, "path" character varying NOT NULL, "statusCode" integer NOT NULL, "requestSummary" jsonb, "responseSummary" jsonb, "durationMs" integer NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "userId" uuid, CONSTRAINT "PK_4f2fbddaca7c6531577e79177a4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_616fe6825e31946269f5f84c52" ON "audit_log_entries" ("projectId") `);
        await queryRunner.query(`CREATE TABLE "inference_assessments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "inputsUsed" jsonb NOT NULL, "decision" character varying(32) NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_6c0eb1437b917f5986ef2603cc0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4cff38ece51575f20102b66f17" ON "inference_assessments" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD CONSTRAINT "FK_953703a5b5478a041c3a53558a0" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD CONSTRAINT "FK_c57c579a187a1e1cf1a668dfc35" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" ADD CONSTRAINT "FK_83f51e0c4db1b234f4898b80bb1" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" ADD CONSTRAINT "FK_67081adccebd48b61618e287685" FOREIGN KEY ("assessmentId") REFERENCES "discovery_assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "data_pipeline_designs" ADD CONSTRAINT "FK_dcd013dc4df2e7dfbe6b9a5978e" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "data_pipeline_designs" ADD CONSTRAINT "FK_7b04629f5a45f4f50ff11d65cda" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "index_designs" ADD CONSTRAINT "FK_11febf7323f8774a2e95c7fd95b" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "index_designs" ADD CONSTRAINT "FK_6a4cfb92fb022a57cffc312cfee" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "deployment_plans" ADD CONSTRAINT "FK_7bbec6114e03c6f932308b2f3c6" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "deployment_plans" ADD CONSTRAINT "FK_f8601ff60f4cef78e2f0607fda2" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ingestion_runs" ADD CONSTRAINT "FK_3c1389dcbebdfc4022f9307f7df" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ingestion_runs" ADD CONSTRAINT "FK_a089473688db1dd01991ac20c69" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "dead_letter_records" ADD CONSTRAINT "FK_f05629992c8093aeb9c6b95aaf6" FOREIGN KEY ("ingestionRunId") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ingestion_content_hashes" ADD CONSTRAINT "FK_f02a0f233f2d7e8625e99c2b3ed" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "optimization_reports" ADD CONSTRAINT "FK_34519804e4ae80abefc8f27a495" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "optimization_reports" ADD CONSTRAINT "FK_69f1b03cbd9fa8d35e6908c67ab" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "capacity_plans" ADD CONSTRAINT "FK_541f581d35eacdc5d4b3cae1a31" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "capacity_plans" ADD CONSTRAINT "FK_92f62f51bf470923446a24b72da" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "audit_log_entries" ADD CONSTRAINT "FK_616fe6825e31946269f5f84c527" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "audit_log_entries" ADD CONSTRAINT "FK_550030d997bc49d758f1f07dec2" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "inference_assessments" ADD CONSTRAINT "FK_4cff38ece51575f20102b66f174" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "inference_assessments" ADD CONSTRAINT "FK_65476a81360dd75a098788fb0c6" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inference_assessments" DROP CONSTRAINT "FK_65476a81360dd75a098788fb0c6"`);
        await queryRunner.query(`ALTER TABLE "inference_assessments" DROP CONSTRAINT "FK_4cff38ece51575f20102b66f174"`);
        await queryRunner.query(`ALTER TABLE "audit_log_entries" DROP CONSTRAINT "FK_550030d997bc49d758f1f07dec2"`);
        await queryRunner.query(`ALTER TABLE "audit_log_entries" DROP CONSTRAINT "FK_616fe6825e31946269f5f84c527"`);
        await queryRunner.query(`ALTER TABLE "capacity_plans" DROP CONSTRAINT "FK_92f62f51bf470923446a24b72da"`);
        await queryRunner.query(`ALTER TABLE "capacity_plans" DROP CONSTRAINT "FK_541f581d35eacdc5d4b3cae1a31"`);
        await queryRunner.query(`ALTER TABLE "optimization_reports" DROP CONSTRAINT "FK_69f1b03cbd9fa8d35e6908c67ab"`);
        await queryRunner.query(`ALTER TABLE "optimization_reports" DROP CONSTRAINT "FK_34519804e4ae80abefc8f27a495"`);
        await queryRunner.query(`ALTER TABLE "ingestion_content_hashes" DROP CONSTRAINT "FK_f02a0f233f2d7e8625e99c2b3ed"`);
        await queryRunner.query(`ALTER TABLE "dead_letter_records" DROP CONSTRAINT "FK_f05629992c8093aeb9c6b95aaf6"`);
        await queryRunner.query(`ALTER TABLE "ingestion_runs" DROP CONSTRAINT "FK_a089473688db1dd01991ac20c69"`);
        await queryRunner.query(`ALTER TABLE "ingestion_runs" DROP CONSTRAINT "FK_3c1389dcbebdfc4022f9307f7df"`);
        await queryRunner.query(`ALTER TABLE "deployment_plans" DROP CONSTRAINT "FK_f8601ff60f4cef78e2f0607fda2"`);
        await queryRunner.query(`ALTER TABLE "deployment_plans" DROP CONSTRAINT "FK_7bbec6114e03c6f932308b2f3c6"`);
        await queryRunner.query(`ALTER TABLE "index_designs" DROP CONSTRAINT "FK_6a4cfb92fb022a57cffc312cfee"`);
        await queryRunner.query(`ALTER TABLE "index_designs" DROP CONSTRAINT "FK_11febf7323f8774a2e95c7fd95b"`);
        await queryRunner.query(`ALTER TABLE "data_pipeline_designs" DROP CONSTRAINT "FK_7b04629f5a45f4f50ff11d65cda"`);
        await queryRunner.query(`ALTER TABLE "data_pipeline_designs" DROP CONSTRAINT "FK_dcd013dc4df2e7dfbe6b9a5978e"`);
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" DROP CONSTRAINT "FK_67081adccebd48b61618e287685"`);
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" DROP CONSTRAINT "FK_83f51e0c4db1b234f4898b80bb1"`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" DROP CONSTRAINT "FK_c57c579a187a1e1cf1a668dfc35"`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" DROP CONSTRAINT "FK_953703a5b5478a041c3a53558a0"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33"`);
        await queryRunner.query(`DROP INDEX "IDX_4cff38ece51575f20102b66f17"`);
        await queryRunner.query(`DROP TABLE "inference_assessments"`);
        await queryRunner.query(`DROP INDEX "IDX_616fe6825e31946269f5f84c52"`);
        await queryRunner.query(`DROP TABLE "audit_log_entries"`);
        await queryRunner.query(`DROP INDEX "IDX_541f581d35eacdc5d4b3cae1a3"`);
        await queryRunner.query(`DROP TABLE "capacity_plans"`);
        await queryRunner.query(`DROP TYPE "capacity_plans_indextype_enum"`);
        await queryRunner.query(`DROP TYPE "capacity_plans_platform_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_34519804e4ae80abefc8f27a49"`);
        await queryRunner.query(`DROP TABLE "optimization_reports"`);
        await queryRunner.query(`DROP TYPE "optimization_reports_indextype_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_f02a0f233f2d7e8625e99c2b3e"`);
        await queryRunner.query(`DROP TABLE "ingestion_content_hashes"`);
        await queryRunner.query(`DROP INDEX "IDX_f05629992c8093aeb9c6b95aaf"`);
        await queryRunner.query(`DROP TABLE "dead_letter_records"`);
        await queryRunner.query(`DROP INDEX "IDX_3c1389dcbebdfc4022f9307f7d"`);
        await queryRunner.query(`DROP TABLE "ingestion_runs"`);
        await queryRunner.query(`DROP TYPE "ingestion_runs_status_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_7bbec6114e03c6f932308b2f3c"`);
        await queryRunner.query(`DROP TABLE "deployment_plans"`);
        await queryRunner.query(`DROP TYPE "deployment_plans_platform_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_11febf7323f8774a2e95c7fd95"`);
        await queryRunner.query(`DROP TABLE "index_designs"`);
        await queryRunner.query(`DROP TYPE "index_designs_updatefrequency_enum"`);
        await queryRunner.query(`DROP TYPE "index_designs_decision_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_dcd013dc4df2e7dfbe6b9a5978"`);
        await queryRunner.query(`DROP TABLE "data_pipeline_designs"`);
        await queryRunner.query(`DROP TYPE "data_pipeline_designs_dimensionmismatchreason_enum"`);
        await queryRunner.query(`DROP TYPE "data_pipeline_designs_similaritymetric_enum"`);
        await queryRunner.query(`DROP TYPE "data_pipeline_designs_chunkingstrategy_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_83f51e0c4db1b234f4898b80bb"`);
        await queryRunner.query(`DROP TABLE "architecture_decision_records"`);
        await queryRunner.query(`DROP TYPE "architecture_decision_records_confidence_enum"`);
        await queryRunner.query(`DROP TYPE "architecture_decision_records_decisionstatus_enum"`);
        await queryRunner.query(`DROP TYPE "architecture_decision_records_decision_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_953703a5b5478a041c3a53558a"`);
        await queryRunner.query(`DROP TABLE "discovery_assessments"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_tenancymodel_enum"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_datareplicationmodel_enum"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_operationalcapability_enum"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_deploymentenvironment_enum"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_qpsscope_enum"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_similaritymetric_enum"`);
        await queryRunner.query(`DROP TYPE "discovery_assessments_environment_enum"`);
        await queryRunner.query(`DROP TABLE "projects"`);
        await queryRunner.query(`DROP TYPE "projects_platform_enum"`);
        await queryRunner.query(`DROP TYPE "projects_customermode_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "users_role_enum"`);
    }
}
