import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 12 (Token Observability, phase 0): ai_token_estimates, the
 * versioned Estimated-mode token and cost projection. Additive only - no
 * existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiTokenEstimates1790353304271 implements MigrationInterface {
    name = 'AiTokenEstimates1790353304271';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_token_estimates')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_token_estimates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_f7ba0b8be59ee8ce319f3853877" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f68a0409b0e8ac525911b245c5" ON "ai_token_estimates" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_token_estimates" ADD CONSTRAINT "FK_f68a0409b0e8ac525911b245c52" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_token_estimates" ADD CONSTRAINT "FK_28288ed9a92820a41b3d4bebccc" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_token_estimates" DROP CONSTRAINT "FK_28288ed9a92820a41b3d4bebccc"`);
        await queryRunner.query(`ALTER TABLE "ai_token_estimates" DROP CONSTRAINT "FK_f68a0409b0e8ac525911b245c52"`);
        await queryRunner.query(`DROP INDEX "IDX_f68a0409b0e8ac525911b245c5"`);
        await queryRunner.query(`DROP TABLE "ai_token_estimates"`);
    }
}
