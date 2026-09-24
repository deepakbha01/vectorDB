import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export const METRIC_IDS = [
  'recall', 'qps', 'search_latency_p95', 'search_latency_p99', 'index_build_time',
  'embedding_tokens_per_sec', 'documents_per_sec', 'embedding_cost',
  'ttft_p50', 'ttft_p95', 'ttft_p99', 'output_tokens_per_sec', 'e2e_p95', 'quality',
  'gpu_utilization', 'gpu_memory', 'cpu_utilization', 'ram_utilization', 'network',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/** A benchmark result the architect ran outside the platform. Its source is mandatory: no evidence, no measurement. */
export class MeasurementDto {
  @ApiProperty({ enum: METRIC_IDS })
  @IsIn(METRIC_IDS as unknown as string[])
  metric: MetricId;

  @ApiProperty()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  value: number;

  @ApiProperty({ description: 'Tool, environment and load used, e.g. "vLLM benchmark_serving, prod-like cluster, 40 concurrent"' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  source: string;

  @ApiProperty({ required: false, description: 'When it was measured (ISO date)' })
  @IsOptional()
  @IsISO8601()
  measuredAt?: string;
}

export class CreatePerformanceAssessmentDto {
  @ApiProperty({ required: false, type: [MeasurementDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MeasurementDto)
  measurements?: MeasurementDto[];
}
