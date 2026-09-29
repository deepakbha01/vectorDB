import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optimization reports record how the benchmark searched: `ann` (the tuned
 * vector index) or `exact_scan` (PostgreSQL without pgvector - a brute-force
 * scan whose latency/recall/throughput do not describe the index). Nullable:
 * reports saved before this was recorded stay null. IF NOT EXISTS: a database
 * already updated by `synchronize: true` has the column.
 */
export class OptimizationSearchMode1790700000000 implements MigrationInterface {
    name = 'OptimizationSearchMode1790700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "optimization_reports" ADD COLUMN IF NOT EXISTS "searchMode" character varying(16)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "optimization_reports" DROP COLUMN IF EXISTS "searchMode"`);
    }
}
