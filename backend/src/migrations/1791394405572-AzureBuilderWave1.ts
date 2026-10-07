import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 1: Phase 0 (Connect) target connections and
 * Phase 1 (Discover) environment profiles, both versioned per project. No
 * credentials are stored. Generated from the entities (constraint names match
 * TypeORM's); the unrelated `projects.phaseStatuses` default-ordering diff was
 * removed. Guarded: a database already updated by `synchronize: true` only
 * records it as applied.
 */
export class AzureBuilderWave11791394405572 implements MigrationInterface {
    name = 'AzureBuilderWave11791394405572';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [exists] = await queryRunner.query(`SELECT to_regclass(current_schema() || '.azure_builder_connections') IS NOT NULL AS present`);
        if (exists?.present) return;
        await queryRunner.query(`CREATE TABLE "azure_builder_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "active" boolean NOT NULL DEFAULT true, "source" character varying(16) NOT NULL, "tenantId" character varying(36) NOT NULL, "subscriptionId" character varying(36) NOT NULL, "subscriptionName" character varying(120), "resourceGroup" character varying(90) NOT NULL, "resourceGroupMode" character varying(16) NOT NULL, "region" character varying(40) NOT NULL, "deploymentModel" character varying(24) NOT NULL, "role" character varying(16) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_cda26fefeb73f9e3198cf741e92" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a1e1e1d21302e39d484a65c4dd" ON "azure_builder_connections" ("projectId") `);
        await queryRunner.query(`CREATE TABLE "azure_builder_environment_profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "connectionVersion" integer NOT NULL, "source" character varying(16) NOT NULL, "profile" jsonb NOT NULL, "constraints" jsonb NOT NULL, "problems" jsonb NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_d2bf0e40e5c7097094d149db98f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d162e2f24498149f0c6d371e8b" ON "azure_builder_environment_profiles" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "azure_builder_connections" ADD CONSTRAINT "FK_a1e1e1d21302e39d484a65c4dde" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_connections" ADD CONSTRAINT "FK_4cee9c4f1a5f2b5b706b9bb2a05" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_environment_profiles" ADD CONSTRAINT "FK_d162e2f24498149f0c6d371e8b8" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_environment_profiles" ADD CONSTRAINT "FK_f7fe02d12a80bdc9dc53bc021a8" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_environment_profiles"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_connections"`);
    }
}
