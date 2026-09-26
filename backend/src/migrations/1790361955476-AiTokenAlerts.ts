import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 12 (Token Observability, phase 7): ai_token_alerts (spec
 * §14) - one row per alerting problem, kept open while its rule fires and
 * resolved when it stops. Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiTokenAlerts1790361955476 implements MigrationInterface {
    name = 'AiTokenAlerts1790361955476';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_token_alerts')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_token_alerts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rule" character varying(32) NOT NULL, "dedupeKey" character varying(300) NOT NULL, "severity" character varying(16) NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'open', "title" character varying(300) NOT NULL, "detail" text NOT NULL, "metric" jsonb NOT NULL, "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "resolvedAt" TIMESTAMP WITH TIME ZONE, "acknowledgedAt" TIMESTAMP WITH TIME ZONE, "projectId" uuid, "acknowledgedById" uuid, CONSTRAINT "PK_0e546be3d5cd277015f7a6c3ff0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6679d17ffbd2d861e4ba69553a" ON "ai_token_alerts" ("projectId", "status") `);
        await queryRunner.query(`ALTER TABLE "ai_token_alerts" ADD CONSTRAINT "FK_3abd701900f2066745a6f015d3b" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_token_alerts" ADD CONSTRAINT "FK_3370626cd77b14f1e3c25469d8d" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_token_alerts" DROP CONSTRAINT "FK_3370626cd77b14f1e3c25469d8d"`);
        await queryRunner.query(`ALTER TABLE "ai_token_alerts" DROP CONSTRAINT "FK_3abd701900f2066745a6f015d3b"`);
        await queryRunner.query(`DROP INDEX "IDX_6679d17ffbd2d861e4ba69553a"`);
        await queryRunner.query(`DROP TABLE "ai_token_alerts"`);
    }
}
