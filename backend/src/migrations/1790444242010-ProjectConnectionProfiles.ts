import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-project connection profiles (Data Explorer phase 3): a project's own
 * connection to its target vector database, stored sealed with AES-256-GCM.
 * Generated as the difference between the entities and a schema at the
 * previous migrations. Guarded: a database already updated by
 * `synchronize: true` only records it as applied.
 */
export class ProjectConnectionProfiles1790444242010 implements MigrationInterface {
    name = 'ProjectConnectionProfiles1790444242010';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [exists] = await queryRunner.query(`SELECT to_regclass(current_schema() || '.project_connection_profiles') IS NOT NULL AS present`);
        if (exists?.present) return;
        await queryRunner.query(`CREATE TABLE "project_connection_profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "platform" character varying(64) NOT NULL, "settingsSealed" text NOT NULL, "keysSet" jsonb NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "updatedById" uuid, CONSTRAINT "REL_33762ba5b456e7b4fd1d077481" UNIQUE ("projectId"), CONSTRAINT "PK_b9e75e23585e54c969042c58cda" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "project_connection_profiles" ADD CONSTRAINT "FK_33762ba5b456e7b4fd1d0774813" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_connection_profiles" ADD CONSTRAINT "FK_a5a7cff94dc4fb4afde1b00c17c" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "project_connection_profiles"`);
    }
}
