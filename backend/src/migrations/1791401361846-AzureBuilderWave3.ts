import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Azure AI Factory Builder, Wave 3: Phase 3 (Architect) - versioned
 * ArchitectureSpec records with the use case and Environment Profile versions
 * they were designed from. Generated from the entity (constraint names match
 * TypeORM's); the unrelated `projects.phaseStatuses` default-ordering diff was
 * removed. Guarded: a database already updated by `synchronize: true` only
 * records it as applied.
 */
export class AzureBuilderWave31791401361846 implements MigrationInterface {
    name = 'AzureBuilderWave31791401361846';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [exists] = await queryRunner.query(`SELECT to_regclass(current_schema() || '.azure_builder_architectures') IS NOT NULL AS present`);
        if (exists?.present) return;
        await queryRunner.query(`CREATE TABLE "azure_builder_architectures" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "useCaseVersion" integer NOT NULL, "profileVersion" integer NOT NULL, "spec" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_c3e6dc8f7c170b7e55117ff44dc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_47a60bead4f4a468afac9239b7" ON "azure_builder_architectures" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "azure_builder_architectures" ADD CONSTRAINT "FK_47a60bead4f4a468afac9239b7e" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "azure_builder_architectures" ADD CONSTRAINT "FK_80a7b5a0fea6c15fb3e3622a58d" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "azure_builder_architectures"`);
    }
}
