import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 4: ai_inference_architectures (the Inference Architecture
 * Decision Record, spec §8). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiInferenceArchitectures1790182338236 implements MigrationInterface {
    name = 'AiInferenceArchitectures1790182338236';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_inference_architectures')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_inference_architectures" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_ac67b77bb146c7b56846b2fdc72" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c672f97b7a0f7bae1dc10adb86" ON "ai_inference_architectures" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_inference_architectures" ADD CONSTRAINT "FK_c672f97b7a0f7bae1dc10adb865" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_inference_architectures" ADD CONSTRAINT "FK_20fbc6a9e8787c2a5daa8dae535" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_inference_architectures" DROP CONSTRAINT "FK_20fbc6a9e8787c2a5daa8dae535"`);
        await queryRunner.query(`ALTER TABLE "ai_inference_architectures" DROP CONSTRAINT "FK_c672f97b7a0f7bae1dc10adb865"`);
        await queryRunner.query(`DROP INDEX "IDX_c672f97b7a0f7bae1dc10adb86"`);
        await queryRunner.query(`DROP TABLE "ai_inference_architectures"`);
    }
}
