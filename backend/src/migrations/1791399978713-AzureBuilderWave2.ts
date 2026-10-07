import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 2: Phase 2 (Use case intake) - versioned
 * UseCaseSpec records with the classifier's output. Generated from the entity
 * (constraint names match TypeORM's); the unrelated `projects.phaseStatuses`
 * default-ordering diff was removed. Guarded: a database already updated by
 * `synchronize: true` only records it as applied.
 */
export class AzureBuilderWave21791399978713 implements MigrationInterface {
    name = 'AzureBuilderWave21791399978713';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [exists] = await queryRunner.query(`SELECT to_regclass(current_schema() || '.azure_builder_use_cases') IS NOT NULL AS present`);
        if (exists?.present) return;
        await queryRunner.query(`CREATE TABLE "azure_builder_use_cases" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "spec" jsonb NOT NULL, "classification" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_a26f9392bd73135dc25d287bc08" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f0cff1520c790d56724be55e89" ON "azure_builder_use_cases" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "azure_builder_use_cases" ADD CONSTRAINT "FK_f0cff1520c790d56724be55e893" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_use_cases" ADD CONSTRAINT "FK_78dec5b41f95de633205612e283" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_use_cases"`);
    }
}
