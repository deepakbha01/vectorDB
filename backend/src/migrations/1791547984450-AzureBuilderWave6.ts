import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 6a: live Connect. A connection verified against
 * Azure records the effective permissions Azure reported on the target scope and
 * the Azure account that verified it (a UPN, not a credential - no token is ever
 * stored). Guarded, so a database already updated by `synchronize: true` is unchanged.
 */
export class AzureBuilderWave61791547984450 implements MigrationInterface {
    name = 'AzureBuilderWave61791547984450';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "azure_builder_connections" ADD COLUMN IF NOT EXISTS "permissions" jsonb`);
        await queryRunner.query(`ALTER TABLE "azure_builder_connections" ADD COLUMN IF NOT EXISTS "azureUser" character varying(256)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "azure_builder_connections" DROP COLUMN IF EXISTS "azureUser"`);
        await queryRunner.query(`ALTER TABLE "azure_builder_connections" DROP COLUMN IF EXISTS "permissions"`);
    }
}
