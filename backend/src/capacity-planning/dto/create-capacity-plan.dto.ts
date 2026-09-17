import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Every field defaults from the project's latest Discovery assessment
 * (Phase 1) and Index Design (Phase 3) - pass any of these to override that
 * default for a what-if forecast.
 */
export class CreateCapacityPlanDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  currentVectorCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  currentQps?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  availableMemoryGb?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  availableCpuCores?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  availableStorageGb?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyGrowthPercent?: number;
}
