import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 2: ai_workload_profiles (the AI Workload Profile, spec §4).
 * Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiWorkloadProfiles1790178687791 implements MigrationInterface {
    name = 'AiWorkloadProfiles1790178687791';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_workload_profiles')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_workload_profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "inputs" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_7fb8e1042e6c0f620042f82579d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8d57a8264344238cffcdfd2d3f" ON "ai_workload_profiles" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_workload_profiles" ADD CONSTRAINT "FK_8d57a8264344238cffcdfd2d3f0" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_workload_profiles" ADD CONSTRAINT "FK_1953a4c912aab1bcdfe3559f54b" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_workload_profiles" DROP CONSTRAINT "FK_1953a4c912aab1bcdfe3559f54b"`);
        await queryRunner.query(`ALTER TABLE "ai_workload_profiles" DROP CONSTRAINT "FK_8d57a8264344238cffcdfd2d3f0"`);
        await queryRunner.query(`DROP INDEX "IDX_8d57a8264344238cffcdfd2d3f"`);
        await queryRunner.query(`DROP TABLE "ai_workload_profiles"`);
    }
}
