import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 5: Phase 5 (Validate & approve) - what-if runs
 * with their validation reports, immutable approval records bound to the IaC
 * hash, and the required-input columns on IaC bundles. Generated from the
 * entities (constraint names match TypeORM's); the unrelated
 * `projects.phaseStatuses` default-ordering diff was removed. Each step is
 * guarded, so a database already updated by `synchronize: true` only gains
 * what it lacks - including the trigger that keeps approvals immutable, which
 * synchronize cannot create.
 */
export class AzureBuilderWave51791435672351 implements MigrationInterface {
    name = 'AzureBuilderWave51791435672351';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = async (table: string) => (await queryRunner.query(`SELECT to_regclass(current_schema() || '.${table}') IS NOT NULL AS present`))[0]?.present;
        if (!(await exists('azure_builder_what_ifs'))) {
            await queryRunner.query(`CREATE TABLE "azure_builder_what_ifs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "iacVersion" integer NOT NULL, "iacHash" character varying NOT NULL, "environment" character varying NOT NULL, "source" character varying NOT NULL, "status" character varying NOT NULL, "changes" jsonb NOT NULL, "report" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_c12a1772412976f4aabde72063e" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE INDEX "IDX_d3eb2e6c60e91c5c9fef1bb878" ON "azure_builder_what_ifs" ("projectId") `);
            await queryRunner.query(`ALTER TABLE "azure_builder_what_ifs" ADD CONSTRAINT "FK_d3eb2e6c60e91c5c9fef1bb878c" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "azure_builder_what_ifs" ADD CONSTRAINT "FK_48bfa55d913668c5dd04d0ec362" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        }
        if (!(await exists('azure_builder_approvals'))) {
            await queryRunner.query(`CREATE TABLE "azure_builder_approvals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "approverEmail" character varying NOT NULL, "environment" character varying NOT NULL, "decision" character varying NOT NULL, "comments" text, "iacVersion" integer NOT NULL, "iacHash" character varying NOT NULL, "architectureVersion" integer NOT NULL, "useCaseVersion" integer NOT NULL, "whatIfId" character varying NOT NULL, "evidence" character varying NOT NULL, "raiChecklist" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "approverId" uuid, CONSTRAINT "PK_719dea1afd808b48fb1b45378f6" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE INDEX "IDX_d03f0fac0cc50d2227dc915f1e" ON "azure_builder_approvals" ("projectId") `);
            await queryRunner.query(`ALTER TABLE "azure_builder_approvals" ADD CONSTRAINT "FK_d03f0fac0cc50d2227dc915f1ed" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
            await queryRunner.query(`ALTER TABLE "azure_builder_approvals" ADD CONSTRAINT "FK_6797017eaa5de33ddad79118afd" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        }
        await queryRunner.query(`ALTER TABLE "azure_builder_iac_bundles" ADD COLUMN IF NOT EXISTS "inputs" jsonb NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "azure_builder_iac_bundles" ADD COLUMN IF NOT EXISTS "missingInputs" jsonb NOT NULL DEFAULT '{}'`);
        // Approvals are immutable (spec 4.6): any UPDATE fails. Deletes stay possible so a project can still be removed.
        await queryRunner.query(`CREATE OR REPLACE FUNCTION azure_builder_approvals_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'azure_builder_approvals rows are immutable - record a new decision instead'; END; $$ LANGUAGE plpgsql`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS azure_builder_approvals_no_update ON "azure_builder_approvals"`);
        await queryRunner.query(`CREATE TRIGGER azure_builder_approvals_no_update BEFORE UPDATE ON "azure_builder_approvals" FOR EACH ROW EXECUTE FUNCTION azure_builder_approvals_immutable()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_approvals"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS azure_builder_approvals_immutable()`);
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_what_ifs"`);
        await queryRunner.query(`ALTER TABLE "azure_builder_iac_bundles" DROP COLUMN IF EXISTS "missingInputs"`);
        await queryRunner.query(`ALTER TABLE "azure_builder_iac_bundles" DROP COLUMN IF EXISTS "inputs"`);
    }
}
