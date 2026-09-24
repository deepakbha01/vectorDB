import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 7: ai_security_assessments (the AI Security & Governance
 * Assessment, spec §12). Additive only - no existing table is altered.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Development databases
 * using `synchronize: true` already have the table; up() then only records
 * this migration as applied.
 */
export class AiSecurityAssessments1790190851170 implements MigrationInterface {
    name = 'AiSecurityAssessments1790190851170';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ai_security_assessments')) {
            return;
        }
        await queryRunner.query(`CREATE TABLE "ai_security_assessments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "submitted" jsonb NOT NULL, "context" jsonb NOT NULL, "sources" jsonb NOT NULL, "result" jsonb NOT NULL, "rulesVersion" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid, "createdById" uuid, CONSTRAINT "PK_258a5df53df3fd4dab62249d0ec" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5cee2576d9334d27ad08689cd1" ON "ai_security_assessments" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "ai_security_assessments" ADD CONSTRAINT "FK_5cee2576d9334d27ad08689cd11" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ai_security_assessments" ADD CONSTRAINT "FK_ece37bdaf14ffcbde7bedeb60b9" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_security_assessments" DROP CONSTRAINT "FK_ece37bdaf14ffcbde7bedeb60b9"`);
        await queryRunner.query(`ALTER TABLE "ai_security_assessments" DROP CONSTRAINT "FK_5cee2576d9334d27ad08689cd11"`);
        await queryRunner.query(`DROP INDEX "IDX_5cee2576d9334d27ad08689cd1"`);
        await queryRunner.query(`DROP TABLE "ai_security_assessments"`);
    }
}
