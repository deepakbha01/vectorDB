import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 5: ai_infrastructure_designs (the Infrastructure Decision Record,
 * spec §9). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiInfrastructureDesigns1790188588717 implements MigrationInterface {
    name = 'AiInfrastructureDesigns1790188588717';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_infrastructure_designs')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_infrastructure_designs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_b8ed0b487bdf352d91314ae1641" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cf33c8fd51d2e82a901a38cc7e" ON "ai_infrastructure_designs" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_infrastructure_designs" ADD CONSTRAINT "FK_cf33c8fd51d2e82a901a38cc7ea" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_infrastructure_designs" ADD CONSTRAINT "FK_c234c51df92eca98175f6c1de68" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_infrastructure_designs" DROP CONSTRAINT "FK_c234c51df92eca98175f6c1de68"`);
        await queryRunner.query(`ALTER TABLE "ai_infrastructure_designs" DROP CONSTRAINT "FK_cf33c8fd51d2e82a901a38cc7ea"`);
        await queryRunner.query(`DROP INDEX "IDX_cf33c8fd51d2e82a901a38cc7e"`);
        await queryRunner.query(`DROP TABLE "ai_infrastructure_designs"`);
    }
}
