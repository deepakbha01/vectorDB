import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 3: ai_model_selections (the Model Decision Record, spec §7).
 * Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiModelSelections1790179946896 implements MigrationInterface {
    name = 'AiModelSelections1790179946896';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_model_selections')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_model_selections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "requirements" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_30023b996609c8c5423e6a1a70f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f4be22d06ac0d14c8826ca0323" ON "ai_model_selections" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_model_selections" ADD CONSTRAINT "FK_f4be22d06ac0d14c8826ca03232" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_model_selections" ADD CONSTRAINT "FK_39c58b1a9648f43a4e787073209" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_model_selections" DROP CONSTRAINT "FK_39c58b1a9648f43a4e787073209"`);
        await queryRunner.query(`ALTER TABLE "ai_model_selections" DROP CONSTRAINT "FK_f4be22d06ac0d14c8826ca03232"`);
        await queryRunner.query(`DROP INDEX "IDX_f4be22d06ac0d14c8826ca0323"`);
        await queryRunner.query(`DROP TABLE "ai_model_selections"`);
    }
}
