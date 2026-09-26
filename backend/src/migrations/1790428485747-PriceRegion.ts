import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Regional token prices (validation spec §11): ai_model_prices.region, null =
 * every region. Existing rows keep null, so their meaning is unchanged.
 * Guarded: a database already updated by `synchronize: true` is left as is.
 */
export class PriceRegion1790428485747 implements MigrationInterface {
    name = 'PriceRegion1790428485747';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_model_prices" ADD COLUMN IF NOT EXISTS "region" character varying(64)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_model_prices" DROP COLUMN IF EXISTS "region"`);
    }
}
