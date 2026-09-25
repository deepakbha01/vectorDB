import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 12 (Token Observability, phase 1): ai_model_prices
 * (versioned token prices, spec §13), ai_usage_events (normalized usage
 * events, spec §10) and ai_usage_rollups (hourly totals). Additive only - no
 * existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the tables; up() then only records
 * this migration as applied.
 */
export class AiTokenUsageAndPrices1790353685329 implements MigrationInterface {
    name = 'AiTokenUsageAndPrices1790353685329';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_model_prices')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_model_prices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "provider" character varying NOT NULL, "model" character varying NOT NULL, "tokenType" character varying(32) NOT NULL, "pricePer1M" numeric(18,8) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'USD', "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL, "effectiveTo" TIMESTAMP WITH TIME ZONE, "source" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, CONSTRAINT "PK_1d621d2311a65deb14622dcda5f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4f3da807e1083220fd3a2d1375" ON "ai_model_prices" ("projectId") `);
        await queryRunner.query(`CREATE INDEX "IDX_477fe0f5fde46920831483fd58" ON "ai_model_prices" ("provider", "model", "tokenType", "effectiveFrom") `);
        await queryRunner.query(`CREATE TABLE "ai_usage_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventId" character varying NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "requestId" character varying, "traceId" character varying, "spanId" character varying, "parentSpanId" character varying, "tenantId" character varying, "applicationId" character varying, "serviceId" character varying, "workflowId" character varying, "agentId" character varying, "sessionId" character varying, "provider" character varying NOT NULL, "model" character varying NOT NULL, "modelVersion" character varying, "operationType" character varying NOT NULL, "ragStage" character varying, "toolName" character varying, "environment" character varying, "region" character varying, "inputTokens" integer NOT NULL DEFAULT '0', "outputTokens" integer NOT NULL DEFAULT '0', "reasoningTokens" integer, "cachedInputTokens" integer, "totalTokens" integer NOT NULL DEFAULT '0', "embeddingTokens" integer NOT NULL DEFAULT '0', "rerankingTokens" integer NOT NULL DEFAULT '0', "contextTokens" integer NOT NULL DEFAULT '0', "retrievalCount" integer NOT NULL DEFAULT '0', "toolCallCount" integer NOT NULL DEFAULT '0', "llmCallCount" integer NOT NULL DEFAULT '0', "latencyMs" integer, "ttftMs" integer, "requestStatus" character varying(16) NOT NULL DEFAULT 'success', "errorType" character varying, "estimatedInputCost" numeric(18,8), "estimatedOutputCost" numeric(18,8), "estimatedTotalCost" numeric(18,8), "currency" character varying(3), "priceRefs" jsonb NOT NULL DEFAULT '[]', "telemetrySource" character varying(16) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, CONSTRAINT "UQ_c3529e39a51ff821434933000ad" UNIQUE ("projectId", "eventId"), CONSTRAINT "PK_6c8045e563128d5468acd8e2900" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_77f3c3a19c390ab00d19ec628d" ON "ai_usage_events" ("projectId", "telemetrySource", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_cf61d12d7a756996e150e51d14" ON "ai_usage_events" ("projectId", "traceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_53ee30941d203f90f2e0adb878" ON "ai_usage_events" ("projectId", "timestamp") `);
        await queryRunner.query(`CREATE TABLE "ai_usage_rollups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bucketStart" TIMESTAMP WITH TIME ZONE NOT NULL, "telemetrySource" character varying(16) NOT NULL, "environment" character varying NOT NULL DEFAULT '', "tenantId" character varying NOT NULL DEFAULT '', "applicationId" character varying NOT NULL DEFAULT '', "serviceId" character varying NOT NULL DEFAULT '', "workflowId" character varying NOT NULL DEFAULT '', "agentId" character varying NOT NULL DEFAULT '', "provider" character varying NOT NULL DEFAULT '', "model" character varying NOT NULL DEFAULT '', "operationType" character varying NOT NULL DEFAULT '', "events" integer NOT NULL DEFAULT '0', "errors" integer NOT NULL DEFAULT '0', "inputTokens" bigint NOT NULL DEFAULT '0', "outputTokens" bigint NOT NULL DEFAULT '0', "reasoningTokens" bigint NOT NULL DEFAULT '0', "cachedInputTokens" bigint NOT NULL DEFAULT '0', "totalTokens" bigint NOT NULL DEFAULT '0', "embeddingTokens" bigint NOT NULL DEFAULT '0', "rerankingTokens" bigint NOT NULL DEFAULT '0', "contextTokens" bigint NOT NULL DEFAULT '0', "llmCalls" integer NOT NULL DEFAULT '0', "toolCalls" integer NOT NULL DEFAULT '0', "latencyMsSum" bigint NOT NULL DEFAULT '0', "costTotal" numeric(18,8) NOT NULL DEFAULT '0', "projectId" uuid, CONSTRAINT "UQ_12c0ceb18cc1252815fce53502d" UNIQUE ("projectId", "bucketStart", "telemetrySource", "environment", "tenantId", "applicationId", "serviceId", "workflowId", "agentId", "provider", "model", "operationType"), CONSTRAINT "PK_53024d86fa087de73bc7e22f92e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d286c8273fede3e0807482af9f" ON "ai_usage_rollups" ("projectId", "telemetrySource", "bucketStart") `);
        await queryRunner.query(`ALTER TABLE "ai_model_prices" ADD CONSTRAINT "FK_4f3da807e1083220fd3a2d13752" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_usage_events" ADD CONSTRAINT "FK_e96928df1f6ac478d9ba9586604" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_usage_rollups" ADD CONSTRAINT "FK_0f43f1bdd7ee4f954b15bc5975f" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_usage_rollups" DROP CONSTRAINT "FK_0f43f1bdd7ee4f954b15bc5975f"`);
        await queryRunner.query(`ALTER TABLE "ai_usage_events" DROP CONSTRAINT "FK_e96928df1f6ac478d9ba9586604"`);
        await queryRunner.query(`ALTER TABLE "ai_model_prices" DROP CONSTRAINT "FK_4f3da807e1083220fd3a2d13752"`);
        await queryRunner.query(`DROP INDEX "IDX_d286c8273fede3e0807482af9f"`);
        await queryRunner.query(`DROP TABLE "ai_usage_rollups"`);
        await queryRunner.query(`DROP INDEX "IDX_53ee30941d203f90f2e0adb878"`);
        await queryRunner.query(`DROP INDEX "IDX_cf61d12d7a756996e150e51d14"`);
        await queryRunner.query(`DROP INDEX "IDX_77f3c3a19c390ab00d19ec628d"`);
        await queryRunner.query(`DROP TABLE "ai_usage_events"`);
        await queryRunner.query(`DROP INDEX "IDX_477fe0f5fde46920831483fd58"`);
        await queryRunner.query(`DROP INDEX "IDX_4f3da807e1083220fd3a2d1375"`);
        await queryRunner.query(`DROP TABLE "ai_model_prices"`);
    }
}
