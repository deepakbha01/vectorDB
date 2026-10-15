import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LLM integrations added in the app for the optional AI summaries; API keys
 * stored sealed with AES-256-GCM. Guarded: a database already updated by
 * `synchronize: true` only records it as applied.
 */
export class LlmConnections1792060000000 implements MigrationInterface {
    name = 'LlmConnections1792060000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [exists] = await queryRunner.query(`SELECT to_regclass(current_schema() || '.llm_connections') IS NOT NULL AS present`);
        if (exists?.present) return;
        await queryRunner.query(`CREATE TABLE "llm_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(80) NOT NULL, "provider" character varying(40) NOT NULL, "model" character varying(200) NOT NULL, "baseUrl" character varying(500), "apiVersion" character varying(40), "apiKeySealed" text, "isDefault" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedById" uuid, CONSTRAINT "PK_388f3e716b621f2e25c63700160" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "llm_connections" ADD CONSTRAINT "FK_4aba473a76a32a84b7d9c6e9d43" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "llm_connections"`);
    }
}
