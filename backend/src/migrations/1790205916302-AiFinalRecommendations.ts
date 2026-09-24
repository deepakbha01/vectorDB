import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 11: ai_final_recommendations (the Final AI Architecture
 * Recommendation, spec §15-§18, §25, §26). Additive only - no existing table
 * is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiFinalRecommendations1790205916302 implements MigrationInterface {
    name = 'AiFinalRecommendations1790205916302';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_final_recommendations')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_final_recommendations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_5396b9fac4464f0738e13b99236" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_49e794aa907d3217a06c3b23d6" ON "ai_final_recommendations" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_final_recommendations" ADD CONSTRAINT "FK_49e794aa907d3217a06c3b23d64" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_final_recommendations" ADD CONSTRAINT "FK_518dfc18f269309b077ee742a58" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_final_recommendations" DROP CONSTRAINT "FK_518dfc18f269309b077ee742a58"`);
        await queryRunner.query(`ALTER TABLE "ai_final_recommendations" DROP CONSTRAINT "FK_49e794aa907d3217a06c3b23d64"`);
        await queryRunner.query(`DROP INDEX "IDX_49e794aa907d3217a06c3b23d6"`);
        await queryRunner.query(`DROP TABLE "ai_final_recommendations"`);
    }
}
