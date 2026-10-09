import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 6b: Phase 6 (Deploy) - one row per deployment of an
 * approved IaC bundle as an Azure Deployment Stack, with its status, outputs, resource
 * IDs and errors. Constraint names match TypeORM's; guarded, so a database already
 * updated by `synchronize: true` is unchanged.
 */
export class AzureBuilderWave6b1791555520575 implements MigrationInterface {
    name = 'AzureBuilderWave6b1791555520575';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = (await queryRunner.query(`SELECT to_regclass(current_schema() || '.azure_builder_deployments') IS NOT NULL AS present`))[0]?.present;
        if (exists) return;
        await queryRunner.query(`CREATE TABLE "azure_builder_deployments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "deployedByEmail" character varying NOT NULL, "azureUser" character varying(256), "environment" character varying NOT NULL, "iacVersion" integer NOT NULL, "iacHash" character varying NOT NULL, "approvalId" character varying NOT NULL, "whatIfId" character varying NOT NULL, "subscriptionId" character varying(36) NOT NULL, "resourceGroup" character varying(90) NOT NULL, "stackName" character varying(64) NOT NULL, "stackId" text, "denyMode" character varying(16) NOT NULL, "state" character varying(16) NOT NULL, "provisioningState" character varying(40) NOT NULL, "outputs" jsonb NOT NULL DEFAULT '{}', "resourceIds" jsonb NOT NULL DEFAULT '[]', "errors" jsonb NOT NULL DEFAULT '[]', "armDeploymentId" text, "compiledWith" character varying(80) NOT NULL, "finishedAt" TIMESTAMP, "lastCheckedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "deployedById" uuid, CONSTRAINT "PK_bc2e93cb251fb61391ad55badd9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f177afe7263b2913e391d3ca1" ON "azure_builder_deployments" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "azure_builder_deployments" ADD CONSTRAINT "FK_2f177afe7263b2913e391d3ca13" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_deployments" ADD CONSTRAINT "FK_060cbb24baf62d44416f048ed38" FOREIGN KEY ("deployedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_deployments"`);
    }
}
