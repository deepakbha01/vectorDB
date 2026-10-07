import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retrieval Strategy Assessment ("does this workload need a vector database at
 * all?"). Adds the optional Discovery inputs - query mix, document structure,
 * content type, change frequency, explainability, multilingual - and stores
 * the assessment result on the Architecture Decision Record.
 *
 * Every column is nullable (or defaults to false), so existing assessments and
 * ADRs are untouched and keep today's behaviour. Choice fields are varchar, not
 * Postgres enum types, so adding a value later needs no type migration.
 * IF NOT EXISTS: a database already updated by `synchronize: true` has them.
 */
export class RetrievalStrategyAssessment1791380000000 implements MigrationInterface {
    name = 'RetrievalStrategyAssessment1791380000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "documentStructure" character varying(24)`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "contentModality" character varying(24)`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "contentChangeFrequency" character varying(16)`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "explainabilityNeed" character varying(16)`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "queryMixExactPercent" double precision`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "queryMixMultiHopPercent" double precision`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "queryMixSemanticPercent" double precision`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "queryMixAnalyticsPercent" double precision`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "queryMixRelationshipPercent" double precision`);
        await queryRunner.query(`ALTER TABLE "discovery_assessments" ADD COLUMN IF NOT EXISTS "isMultilingual" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" ADD COLUMN IF NOT EXISTS "retrievalStrategy" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "architecture_decision_records" DROP COLUMN IF EXISTS "retrievalStrategy"`);
        for (const column of [
            'isMultilingual', 'queryMixRelationshipPercent', 'queryMixAnalyticsPercent', 'queryMixSemanticPercent',
            'queryMixMultiHopPercent', 'queryMixExactPercent', 'explainabilityNeed', 'contentChangeFrequency',
            'contentModality', 'documentStructure',
        ]) {
            await queryRunner.query(`ALTER TABLE "discovery_assessments" DROP COLUMN IF EXISTS "${column}"`);
        }
    }
}
