import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, Min } from 'class-validator';
import { UpdateFrequency } from '../../index-recommendation-engine/enums/update-frequency.enum';

/**
 * Phase 3 - Index Design intake. Vector count, dimension, QPS, recall target,
 * latency target, and available memory default to the project's latest
 * Discovery assessment / Data Pipeline Design (Phase 1/2 outputs) so the
 * architect isn't re-entering data already captured - pass any of these to
 * override that default for a what-if comparison.
 */
export class CreateIndexDesignDto {
  @ApiProperty({ enum: UpdateFrequency })
  @IsEnum(UpdateFrequency)
  updateFrequency: UpdateFrequency;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  vectorCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  dimension?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  availableMemoryGb?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  qps?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  recallTarget?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  targetP95LatencyMs?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  topK?: number;
}
