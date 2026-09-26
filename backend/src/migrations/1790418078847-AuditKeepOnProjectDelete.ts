import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deleting a project must not erase its audit trail: audit_log_entries.projectId
 * becomes ON DELETE SET NULL (was CASCADE). Every other table that belongs to a
 * project still cascades.
 *
 * Generated as the difference between the entities and a schema at the
 * previous migrations, and verified in scratch schemas. Guarded: a database
 * already updated by `synchronize: true` only records it as applied.
 */
export class AuditKeepOnProjectDelete1790418078847 implements MigrationInterface {
    name = 'AuditKeepOnProjectDelete1790418078847';

    private async rule(queryRunner: QueryRunner): Promise<string | null> {
        const rows = await queryRunner.query(
            `SELECT confdeltype FROM pg_constraint WHERE conname = 'FK_616fe6825e31946269f5f84c527' AND connamespace = current_schema()::regnamespace`,
        );
        return rows[0]?.confdeltype ?? null;
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        if ((await this.rule(queryRunner)) === 'n') return;
        await queryRunner.query(`ALTER TABLE "audit_log_entries" DROP CONSTRAINT IF EXISTS "FK_616fe6825e31946269f5f84c527"`);
        await queryRunner.query(`ALTER TABLE "audit_log_entries" ADD CONSTRAINT "FK_616fe6825e31946269f5f84c527" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "audit_log_entries" DROP CONSTRAINT IF EXISTS "FK_616fe6825e31946269f5f84c527"`);
        await queryRunner.query(`ALTER TABLE "audit_log_entries" ADD CONSTRAINT "FK_616fe6825e31946269f5f84c527" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
}
