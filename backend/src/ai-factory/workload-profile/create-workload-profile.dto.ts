import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
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
import { AiWorkloadType, BusinessCriticality, DataType, DeploymentTarget } from './workload-profile.types';

/**
 * AI Workload Profile intake (spec §4). Only the business framing, workload
 * types and deployment targets are required here; any scale, performance or
 * compliance answer left blank is taken from the project's Discovery
 * assessment (and marked as such) instead of being asked twice.
 */
export class CreateWorkloadProfileDto {
  // ---- business
  @ApiProperty({ description: 'What the business wants this AI system to achieve' })
  @IsString()
  @MaxLength(500)
  businessObjective: string;

  @ApiProperty({ required: false, description: 'Business domain; defaults to the project industry' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessDomain?: string;

  @ApiProperty({ enum: BusinessCriticality })
  @IsEnum(BusinessCriticality)
  businessCriticality: BusinessCriticality;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedUsers?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  numberOfApplications?: number;

  @ApiProperty({ required: false, description: 'Business SLA in the customer\'s words, e.g. "answers within 3 s during business hours"' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessSla?: string;

  // ---- AI workload & data
  @ApiProperty({ enum: AiWorkloadType, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(AiWorkloadType, { each: true })
  workloadTypes: AiWorkloadType[];

  @ApiProperty({ required: false, isArray: true, description: 'Named source systems, e.g. "SharePoint", "Salesforce"' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  dataSources?: string[];

  @ApiProperty({ enum: DataType, isArray: true, required: false })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(DataType, { each: true })
  dataTypes?: DataType[];

  // ---- scale (blank → Discovery)
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(0) documentCount?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(0) expectedVectorCount?: number;
  @ApiProperty({ required: false, description: 'Model / AI requests per day' }) @IsOptional() @IsNumber() @Min(0) dailyRequests?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) peakQps?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(0) concurrentUsers?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) @Max(1000) dataGrowthPercentPerMonth?: number;

  // ---- performance
  @ApiProperty({ required: false, description: 'End-to-end response latency target (ms)' }) @IsOptional() @IsNumber() @Min(1) targetLatencyMs?: number;
  @ApiProperty({ required: false, description: 'Time-to-first-token target (ms)' }) @IsOptional() @IsNumber() @Min(1) targetTtftMs?: number;
  @ApiProperty({ required: false, description: 'Required throughput (requests/s)' }) @IsOptional() @IsNumber() @Min(0) throughputRps?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) @Max(100) availabilityTargetPercent?: number;

  // ---- deployment
  @ApiProperty({ enum: DeploymentTarget, isArray: true, description: 'Where it may run; more than one means hybrid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(DeploymentTarget, { each: true })
  deploymentTargets: DeploymentTarget[];

  // ---- compliance (blank → Discovery)
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() containsPii?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() containsPhi?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() containsPci?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() confidentialData?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) dataResidencyRequirement?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(300) regulatoryRequirements?: string;
}
