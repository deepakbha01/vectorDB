import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 9: ai_finops_assessments (the Cost & FinOps Assessment,
 * spec §13). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiFinopsAssessments1790193029557 implements MigrationInterface {
    name = 'AiFinopsAssessments1790193029557';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_finops_assessments')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_finops_assessments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_b6453a58bfe2ccf34065654b50b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0d0da7af294f7f559bf3b81beb" ON "ai_finops_assessments" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_finops_assessments" ADD CONSTRAINT "FK_0d0da7af294f7f559bf3b81beb8" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_finops_assessments" ADD CONSTRAINT "FK_287a0b01dec3fee23dbe7b47f5d" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_finops_assessments" DROP CONSTRAINT "FK_287a0b01dec3fee23dbe7b47f5d"`);
        await queryRunner.query(`ALTER TABLE "ai_finops_assessments" DROP CONSTRAINT "FK_0d0da7af294f7f559bf3b81beb8"`);
        await queryRunner.query(`DROP INDEX "IDX_0d0da7af294f7f559bf3b81beb"`);
        await queryRunner.query(`DROP TABLE "ai_finops_assessments"`);
    }
}
