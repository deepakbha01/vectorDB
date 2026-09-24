import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 1: ai_factory_state_snapshots (saved copies of the central
 * assessment state). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * baseline migration, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiFactorySnapshots1790177146289 implements MigrationInterface {
    name = 'AiFactorySnapshots1790177146289';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_factory_state_snapshots')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_factory_state_snapshots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "label" character varying(120), "state" jsonb NOT NULL, "lineage" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_5aa537df64bd80a9ac7486c9891" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_375b544e24b6b3ebaf438a289b" ON "ai_factory_state_snapshots" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_factory_state_snapshots" ADD CONSTRAINT "FK_375b544e24b6b3ebaf438a289b8" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_factory_state_snapshots" ADD CONSTRAINT "FK_fe65532b341a5233c762e322f6d" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_factory_state_snapshots" DROP CONSTRAINT "FK_fe65532b341a5233c762e322f6d"`);
        await queryRunner.query(`ALTER TABLE "ai_factory_state_snapshots" DROP CONSTRAINT "FK_375b544e24b6b3ebaf438a289b8"`);
        await queryRunner.query(`DROP INDEX "IDX_375b544e24b6b3ebaf438a289b"`);
        await queryRunner.query(`DROP TABLE "ai_factory_state_snapshots"`);
    }
}
