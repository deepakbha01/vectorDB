import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 8: ai_performance_assessments (the Performance & Benchmark
 * Assessment, spec §11). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiPerformanceAssessments1790191906836 implements MigrationInterface {
    name = 'AiPerformanceAssessments1790191906836';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_performance_assessments')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_performance_assessments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_a3397cadc95712f33338a63b566" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_32774d8a85aef52d007971512b" ON "ai_performance_assessments" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_performance_assessments" ADD CONSTRAINT "FK_32774d8a85aef52d007971512bc" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_performance_assessments" ADD CONSTRAINT "FK_47822c1b6489295df07cd53dcb7" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_performance_assessments" DROP CONSTRAINT "FK_47822c1b6489295df07cd53dcb7"`);
        await queryRunner.query(`ALTER TABLE "ai_performance_assessments" DROP CONSTRAINT "FK_32774d8a85aef52d007971512bc"`);
        await queryRunner.query(`DROP INDEX "IDX_32774d8a85aef52d007971512b"`);
        await queryRunner.query(`DROP TABLE "ai_performance_assessments"`);
    }
}
