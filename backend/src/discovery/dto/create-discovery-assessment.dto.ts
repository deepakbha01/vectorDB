import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DataReplicationModel,
  DeploymentEnvironment,
  Environment,
  OperationalCapability,
  QpsScope,
  TenancyModel,
} from '../enums/discovery.enum';
import { VectorPlatform } from '../../projects/enums/platform.enum';

/**
 * Phase 1 - Discovery: Use Case & Scale Assessment intake.
 * Field set mirrors the "Collect" list in the source prompt exactly so the
 * Recommendation Engine has everything it needs to score candidate platforms.
 */
export class CreateDiscoveryAssessmentDto {
  @ApiProperty({ enum: Environment })
  @IsEnum(Environment)
  environment: Environment;

  @ApiProperty()
  @IsInt()
  @Min(1)
  documentCount: number;

  @ApiProperty({ description: 'Expected document growth, percent per month' })
  @IsNumber()
  @Min(0)
  @Max(1000)
  documentGrowthPercentPerMonth: number;

  @ApiProperty({ description: 'Average document size in KB' })
  @IsNumber()
  @Min(0.01)
  avgDocumentSizeKb: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  chunksPerDocument: number;

  @ApiProperty({ description: 'Estimated total vector count across the corpus' })
  @IsInt()
  @Min(1)
  estimatedVectorCount: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(65536)
  embeddingDimension: number;

  @ApiProperty({ description: 'Sustained queries per second' })
  @IsNumber()
  @Min(0)
  qps: number;

  @ApiProperty({ description: 'Peak queries per second' })
  @IsNumber()
  @Min(0)
  peakQps: number;

  @ApiProperty({
    enum: QpsScope,
    description: 'What the QPS figures above actually measure - aggregate, per-region, or per-index. Materially changes sizing once multi-region is in play.',
  })
  @IsEnum(QpsScope)
  qpsScope: QpsScope;

  @ApiProperty()
  @IsInt()
  @Min(0)
  concurrentUsers: number;

  @ApiProperty({ description: 'Target P95 query latency in milliseconds' })
  @IsNumber()
  @Min(1)
  targetP95LatencyMs: number;

  @ApiProperty({ description: 'Target P99 query latency in milliseconds' })
  @IsNumber()
  @Min(1)
  targetP99LatencyMs: number;

  @ApiProperty({ description: 'Target availability, percent (e.g. 99.9)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  availabilityTargetPercent: number;

  @ApiProperty({ description: 'Recovery Point Objective, minutes' })
  @IsInt()
  @Min(0)
  rpoMinutes: number;

  @ApiProperty({ description: 'Recovery Time Objective, minutes' })
  @IsInt()
  @Min(0)
  rtoMinutes: number;

  @ApiProperty({ description: 'Retention period, days' })
  @IsInt()
  @Min(1)
  retentionDays: number;

  @ApiProperty()
  @IsBoolean()
  requiresSimilaritySearch: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresSemanticSearch: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresHybridSearch: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresMetadataFiltering: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresFullTextSearch: boolean;

  @ApiProperty()
  @IsInt()
  @Min(1)
  topK: number;

  @ApiProperty({ description: 'Target recall@K, 0-1' })
  @IsNumber()
  @Min(0)
  @Max(1)
  recallTarget: number;

  @ApiProperty({ required: false, description: 'Target precision@K, 0-1 - distinct from recall@K; not scored directly (see help text)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  precisionTarget?: number;

  @ApiProperty({ description: 'Results are reranked (e.g. with a cross-encoder) after initial retrieval' })
  @IsBoolean()
  requiresReranking: boolean;

  @ApiProperty({ required: false, description: 'Target NDCG@K, 0-1 - recorded for the record only; not independently scored' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  ndcgTarget?: number;

  @ApiProperty({ required: false, description: 'Target Mean Reciprocal Rank, 0-1 - recorded for the record only; not independently scored' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  mrrTarget?: number;

  @ApiProperty()
  @IsBoolean()
  hasExistingOracle: boolean;

  @ApiProperty()
  @IsBoolean()
  hasExistingPostgres: boolean;

  @ApiProperty()
  @IsBoolean()
  hasExistingKubernetes: boolean;

  @ApiProperty({
    enum: VectorPlatform,
    isArray: true,
    description: 'Vector database platforms (other than Oracle/PostgreSQL, which have their own flags above) already operated in production',
  })
  @IsArray()
  @IsEnum(VectorPlatform, { each: true })
  existingPlatforms: VectorPlatform[];

  @ApiProperty({ enum: DeploymentEnvironment })
  @IsEnum(DeploymentEnvironment)
  deploymentEnvironment: DeploymentEnvironment;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  availableCpuCores: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  availableRamGb: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  availableStorageGb: number;

  @ApiProperty()
  @IsBoolean()
  hasGpu: boolean;

  @ApiProperty({ enum: OperationalCapability, description: 'Team capacity to operate the database day-to-day' })
  @IsEnum(OperationalCapability)
  operationalCapability: OperationalCapability;

  @ApiProperty({ required: false, description: 'Approximate monthly infrastructure budget in USD, if known' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyBudgetUsd?: number;

  @ApiProperty({ description: 'The database must serve reads/writes from more than one geographic region' })
  @IsBoolean()
  requiresMultiRegion: boolean;

  @ApiProperty({ required: false, description: 'Number of deployment regions, if multi-region is required' })
  @IsOptional()
  @IsInt()
  @Min(1)
  deploymentRegionCount?: number;

  @ApiProperty({ required: false, description: 'e.g. "50/30/20" - approximate traffic split across regions' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  trafficDistributionPercent?: string;

  @ApiProperty({ enum: DataReplicationModel })
  @IsEnum(DataReplicationModel)
  dataReplicationModel: DataReplicationModel;

  @ApiProperty()
  @IsBoolean()
  regionalFailoverRequired: boolean;

  @ApiProperty()
  @IsBoolean()
  crossRegionReplicationRequired: boolean;

  @ApiProperty({ enum: TenancyModel })
  @IsEnum(TenancyModel)
  tenancyModel: TenancyModel;

  @ApiProperty()
  @IsBoolean()
  requiresAuthentication: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresRbac: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresEncryptionAtRest: boolean;

  @ApiProperty()
  @IsBoolean()
  requiresEncryptionInTransit: boolean;

  @ApiProperty({ description: 'Customer-managed / bring-your-own-key encryption key management is required' })
  @IsBoolean()
  requiresKeyManagement: boolean;

  @ApiProperty({ description: 'Data belonging to different tenants must be logically or physically isolated' })
  @IsBoolean()
  requiresTenantIsolation: boolean;

  @ApiProperty({ description: 'Access to the database must be captured in an audit log' })
  @IsBoolean()
  requiresAuditLogging: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  dataResidencyRequirement?: string;

  @ApiProperty()
  @IsBoolean()
  containsPii: boolean;

  @ApiProperty({ required: false, description: 'e.g. "HIPAA, GDPR"' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  regulatoryRequirements?: string;
}
