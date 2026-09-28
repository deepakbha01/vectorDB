import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Discovery assessment can have several Vector DB Selection decision
 * records: re-running the selection without a new assessment used to fail on
 * this unique constraint ("duplicate key value violates unique constraint").
 * The foreign key is unchanged. IF EXISTS: a database already updated by
 * `synchronize: true` has no constraint to drop.
 */
export class AdrManyPerAssessment1790515671222 implements MigrationInterface {
    name = 'AdrManyPerAssessment1790515671222';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" DROP CONSTRAINT IF EXISTS "REL_67081adccebd48b61618e28768"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Fails if an assessment has more than one record by then; remove the extra records first.
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" ADD CONSTRAINT "REL_67081adccebd48b61618e28768" UNIQUE ("assessmentId")`);
    }
}
