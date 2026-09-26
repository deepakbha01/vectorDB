import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Factory Wave 12 (Token Observability, code-review fixes):
 * - ai_simulation_runs.status / error, so an upload that fails part-way is
 *   recorded as failed with how far it got;
 * - a partial unique index allowing at most one OPEN alert per problem
 *   (project + dedupe key). Existing duplicate open alerts are resolved
 *   first, keeping the oldest, so the index can be created.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Each change is
 * guarded, so databases already updated by `synchronize: true` only record
 * this migration as applied.
 */
export class TokenReviewFixes1790384458955 implements MigrationInterface {
    name = 'TokenReviewFixes1790384458955';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('ai_simulation_runs', 'status'))) {
            await queryRunner.query(`ALTER TABLE "ai_simulation_runs" ADD "status" character varying(16) NOT NULL DEFAULT 'complete'`);
        }
        if (!(await queryRunner.hasColumn('ai_simulation_runs', 'error'))) {
            await queryRunner.query(`ALTER TABLE "ai_simulation_runs" ADD "error" text`);
        }
        const [{ present }] = await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'UQ_ai_token_alerts_open_problem') AS present`);
        if (!present) {
            await queryRunner.query(
                `UPDATE "ai_token_alerts" a SET "status" = 'resolved', "resolvedAt" = now()
                  WHERE a."status" = 'open' AND EXISTS (
                    SELECT 1 FROM "ai_token_alerts" b
                     WHERE b."status" = 'open' AND b."projectId" = a."projectId" AND b."dedupeKey" = a."dedupeKey"
                       AND (b."firstSeenAt", b."id") < (a."firstSeenAt", a."id"))`,
            );
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_token_alerts_open_problem" ON "ai_token_alerts" ("projectId", "dedupeKey") WHERE "status" = 'open'`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ai_token_alerts_open_problem"`);
        await queryRunner.query(`ALTER TABLE "ai_simulation_runs" DROP COLUMN IF EXISTS "error"`);
        await queryRunner.query(`ALTER TABLE "ai_simulation_runs" DROP COLUMN IF EXISTS "status"`);
    }
}
