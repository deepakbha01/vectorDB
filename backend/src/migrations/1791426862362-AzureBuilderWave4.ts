import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 4: Phase 4 (Generate IaC) - versioned IaC
 * bundles (files, required inputs, Bicep validation result) per ArchitectureSpec
 * version. Generated from the entity (constraint names match TypeORM's); the
 * unrelated `projects.phaseStatuses` default-ordering diff was removed. Guarded:
 * a database already updated by `synchronize: true` only records it as applied.
 */
export class AzureBuilderWave41791426862362 implements MigrationInterface {
    name = 'AzureBuilderWave41791426862362';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [exists] = await queryRunner.query(`SELECT to_regclass(current_schema() || '.azure_builder_iac_bundles') IS NOT NULL AS present`);
        if (exists?.present) return;
        await queryRunner.query(`CREATE TABLE "azure_builder_iac_bundles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "architectureVersion" integer NOT NULL, "workload" character varying NOT NULL, "root" character varying NOT NULL, "generator" character varying NOT NULL, "files" jsonb NOT NULL, "requiredInputs" jsonb NOT NULL, "notes" jsonb NOT NULL, "validation" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_8c09b2d1d2d62d12ac44dce7e63" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8ab21280e5cb9f10ed2f7711bf" ON "azure_builder_iac_bundles" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "azure_builder_iac_bundles" ADD CONSTRAINT "FK_8ab21280e5cb9f10ed2f7711bf4" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_iac_bundles" ADD CONSTRAINT "FK_0dccd3c9c84e22ca9442be23f65" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_iac_bundles"`);
    }
}
