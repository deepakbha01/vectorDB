import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 12 (Token Observability, phase 6): ai_ingest_keys, the
 * per-project machine credentials for live telemetry (spec §11, §18). Only a
 * SHA-256 hash of each key is stored. Additive only - no existing table is
 * altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiIngestKeys1790360876558 implements MigrationInterface {
    name = 'AiIngestKeys1790360876558';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_ingest_keys')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_ingest_keys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "prefix" character varying(16) NOT NULL, "keyHash" character varying(64) NOT NULL, "lastUsedAt" TIMESTAMP WITH TIME ZONE, "revokedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_599fb28f92429a2910f24bb0640" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cea59c5264b97f53aa0182e2f7" ON "ai_ingest_keys" ("projectId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_32dde24ce55b509ca3d9401cde" ON "ai_ingest_keys" ("prefix") `);
        await queryRunner.query(`ALTER TABLE "ai_ingest_keys" ADD CONSTRAINT "FK_cea59c5264b97f53aa0182e2f7b" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_ingest_keys" ADD CONSTRAINT "FK_e90d1494e3ac30b4320d6699283" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_ingest_keys" DROP CONSTRAINT "FK_e90d1494e3ac30b4320d6699283"`);
        await queryRunner.query(`ALTER TABLE "ai_ingest_keys" DROP CONSTRAINT "FK_cea59c5264b97f53aa0182e2f7b"`);
        await queryRunner.query(`DROP INDEX "IDX_32dde24ce55b509ca3d9401cde"`);
        await queryRunner.query(`DROP INDEX "IDX_cea59c5264b97f53aa0182e2f7"`);
        await queryRunner.query(`DROP TABLE "ai_ingest_keys"`);
    }
}
