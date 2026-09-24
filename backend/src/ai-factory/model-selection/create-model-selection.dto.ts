import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

const LEVELS = ['low', 'medium', 'high'] as const;

/**
 * Model requirements (spec §7). Every field is optional: blanks are derived
 * from the AI Workload Profile (workload type, criticality, data
 * classification, deployment targets, TTFT) and the derivation is recorded.
 */
export class CreateModelSelectionDto {
  @ApiProperty({ required: false, description: 'Longest prompt + output that must fit (tokens). Default 8,192.' })
  @IsOptional()
  @IsInt()
  @Min(512)
  requiredContextTokens?: number;

  @ApiProperty({ required: false, enum: LEVELS })
  @IsOptional()
  @IsIn(LEVELS)
  reasoningComplexity?: 'low' | 'medium' | 'high';

  @ApiProperty({ required: false, enum: ['standard', 'high', 'critical'], description: 'Default from business criticality' })
  @IsOptional()
  @IsIn(['standard', 'high', 'critical'])
  accuracyRequirement?: 'standard' | 'high' | 'critical';

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() multilingual?: boolean;
  @ApiProperty({ required: false, description: 'Default: multimodal data in the Workload Profile' }) @IsOptional() @IsBoolean() multimodal?: boolean;
  @ApiProperty({ required: false, description: 'Default: agent or copilot workloads' }) @IsOptional() @IsBoolean() toolCalling?: boolean;
  @ApiProperty({ required: false, description: 'Default: agent or classification workloads' }) @IsOptional() @IsBoolean() structuredOutput?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() codeGeneration?: boolean;

  @ApiProperty({ required: false, enum: ['none', 'adapter', 'full'] })
  @IsOptional()
  @IsIn(['none', 'adapter', 'full'])
  fineTuning?: 'none' | 'adapter' | 'full';

  @ApiProperty({ required: false, description: 'Default: on-premises-only deployment in the Workload Profile' })
  @IsOptional()
  @IsBoolean()
  selfHostingRequired?: boolean;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() permissiveLicenceOnly?: boolean;

  @ApiProperty({ required: false, description: 'Largest open-weight model the available GPUs can host (billions of parameters)' })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  maxSelfHostedParamsB?: number;

  @ApiProperty({ required: false, enum: LEVELS, description: 'Default: high when the TTFT target is under 1 s' })
  @IsOptional()
  @IsIn(LEVELS)
  latencyPriority?: 'low' | 'medium' | 'high';

  @ApiProperty({ required: false, enum: LEVELS })
  @IsOptional()
  @IsIn(LEVELS)
  costPriority?: 'low' | 'medium' | 'high';

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) domain?: string;
}
