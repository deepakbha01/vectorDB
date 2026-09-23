import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 6: ai_rag_agent_designs (the GenAI Application Architecture -
 * RAG / agent design, spec §10). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiRagAgentDesigns1790189769100 implements MigrationInterface {
    name = 'AiRagAgentDesigns1790189769100';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_rag_agent_designs')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_rag_agent_designs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_c5679119bed641ee6a4124ebcc7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c67c1e1470b83a67b38d028c8f" ON "ai_rag_agent_designs" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_rag_agent_designs" ADD CONSTRAINT "FK_c67c1e1470b83a67b38d028c8f5" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_rag_agent_designs" ADD CONSTRAINT "FK_04b28de30dbc327a5d12077cac3" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_rag_agent_designs" DROP CONSTRAINT "FK_04b28de30dbc327a5d12077cac3"`);
        await queryRunner.query(`ALTER TABLE "ai_rag_agent_designs" DROP CONSTRAINT "FK_c67c1e1470b83a67b38d028c8f5"`);
        await queryRunner.query(`DROP INDEX "IDX_c67c1e1470b83a67b38d028c8f"`);
        await queryRunner.query(`DROP TABLE "ai_rag_agent_designs"`);
    }
}
