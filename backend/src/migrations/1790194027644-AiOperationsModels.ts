import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 10: ai_operations_models (the AI Operations Model, spec
 * §14). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiOperationsModels1790194027644 implements MigrationInterface {
    name = 'AiOperationsModels1790194027644';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_operations_models')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_operations_models" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_8faafa5637dfe17dc878da8f774" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a09a6d4bba036cfdd588667265" ON "ai_operations_models" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_operations_models" ADD CONSTRAINT "FK_a09a6d4bba036cfdd5886672656" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_operations_models" ADD CONSTRAINT "FK_3e8effa7d449042720a89c66224" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_operations_models" DROP CONSTRAINT "FK_3e8effa7d449042720a89c66224"`);
        await queryRunner.query(`ALTER TABLE "ai_operations_models" DROP CONSTRAINT "FK_a09a6d4bba036cfdd5886672656"`);
        await queryRunner.query(`DROP INDEX "IDX_a09a6d4bba036cfdd588667265"`);
        await queryRunner.query(`DROP TABLE "ai_operations_models"`);
    }
}
