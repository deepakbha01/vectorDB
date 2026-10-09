import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 6c: Phase 7 (Operate) - an append-only history of
 * smoke tests, drift checks, budget changes and teardowns per deployment. Deployment
 * states gain tearing_down / torn_down / teardown_failed (varchar, no schema change).
 * Constraint names match TypeORM's; guarded for databases already synchronized.
 */
export class AzureBuilderWave6c1791568185861 implements MigrationInterface {
    name = 'AzureBuilderWave6c1791568185861';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = (await queryRunner.query(`SELECT to_regclass(current_schema() || '.azure_builder_operate_checks') IS NOT NULL AS present`))[0]?.present;
        if (exists) return;
        await queryRunner.query(`CREATE TABLE "azure_builder_operate_checks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdByEmail" character varying NOT NULL, "deploymentId" character varying NOT NULL, "environment" character varying NOT NULL, "kind" character varying(16) NOT NULL, "status" character varying(16) NOT NULL, "summary" text NOT NULL, "result" jsonb NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_9ad5f3c55f086519c3f20e229e8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2349fa384ded322aede4ae4130" ON "azure_builder_operate_checks" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "azure_builder_operate_checks" ADD CONSTRAINT "FK_2349fa384ded322aede4ae41302" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_operate_checks" ADD CONSTRAINT "FK_18d27de0a5d2dad68eb5a36a74b" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_operate_checks"`);
    }
}
