import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Architect overrides of the Index Design tuning parameters (with the engine's
 * value kept) and their rationale. Guarded: a database already updated by
 * `synchronize: true` only records it as applied.
 */
export class IndexDesignParameterOverrides1792070000000 implements MigrationInterface {
    name = 'IndexDesignParameterOverrides1792070000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "index_designs" ADD COLUMN IF NOT EXISTS "parameterOverrides" jsonb`);
        await queryRunner.query(`ALTER TABLE "index_designs" ADD COLUMN IF NOT EXISTS "overrideRationale" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "index_designs" DROP COLUMN IF EXISTS "overrideRationale"`);
        await queryRunner.query(`ALTER TABLE "index_designs" DROP COLUMN IF EXISTS "parameterOverrides"`);
    }
}
