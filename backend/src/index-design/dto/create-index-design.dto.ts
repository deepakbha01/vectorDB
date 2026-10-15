import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { UpdateFrequency } from '../../index-recommendation-engine/enums/update-frequency.enum';

/** One tuning parameter set by the architect instead of the engine. */
export class ParameterOverrideDto {
  @ApiProperty({ example: 'M' })
  @IsString()
  @MaxLength(40)
  name: string;

  @ApiProperty({ example: 48 })
  @IsInt()
  value: number;
}

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

  @ApiProperty({
    required: false,
    type: [ParameterOverrideDto],
    description: "Architect overrides of the recommended index's tuning parameters (e.g. HNSW M, efConstruction, efSearch), within config/indexes.yaml bounds.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ParameterOverrideDto)
  parameterOverrides?: ParameterOverrideDto[];

  @ApiProperty({ required: false, description: 'Why the parameters were overridden - required with parameterOverrides, recorded for audit.' })
  @ValidateIf((o: CreateIndexDesignDto) => (o.parameterOverrides?.length ?? 0) > 0)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  overrideRationale?: string;
}
