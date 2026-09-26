import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 12 (Token Observability, phase 5): ai_simulation_runs
 * (uploaded load-test / benchmark results, spec §12 Simulated mode) and
 * ai_usage_events.simulationRunId, so an upload can be removed as a whole.
 * Additive only - one nullable column and an index on ai_usage_events.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have both; up() then only records this
 * migration as applied.
 */
export class AiSimulationRuns1790359832028 implements MigrationInterface {
    name = 'AiSimulationRuns1790359832028';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_simulation_runs')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_simulation_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "label" character varying NOT NULL, "fileName" character varying NOT NULL, "format" character varying(8) NOT NULL, "received" integer NOT NULL, "accepted" integer NOT NULL, "duplicates" integer NOT NULL, "rejected" integer NOT NULL, "unpriced" integer NOT NULL, "firstEventAt" TIMESTAMP WITH TIME ZONE, "lastEventAt" TIMESTAMP WITH TIME ZONE, "rejections" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_db0f6b708ada8ebe0bb309b23b7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d5f62c5299cdb9f1520ad786e7" ON "ai_simulation_runs" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_usage_events" ADD "simulationRunId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_8b0ae473694fd6e02f5ceeb01b" ON "ai_usage_events" ("projectId", "simulationRunId") `);
        await queryRunner.query(`ALTER TABLE "ai_simulation_runs" ADD CONSTRAINT "FK_d5f62c5299cdb9f1520ad786e78" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_simulation_runs" ADD CONSTRAINT "FK_a318da25eff32ed8f3c69d1ba7c" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_simulation_runs" DROP CONSTRAINT "FK_a318da25eff32ed8f3c69d1ba7c"`);
        await queryRunner.query(`ALTER TABLE "ai_simulation_runs" DROP CONSTRAINT "FK_d5f62c5299cdb9f1520ad786e78"`);
        await queryRunner.query(`DROP INDEX "IDX_8b0ae473694fd6e02f5ceeb01b"`);
        await queryRunner.query(`ALTER TABLE "ai_usage_events" DROP COLUMN "simulationRunId"`);
        await queryRunner.query(`DROP INDEX "IDX_d5f62c5299cdb9f1520ad786e7"`);
        await queryRunner.query(`DROP TABLE "ai_simulation_runs"`);
    }
}
