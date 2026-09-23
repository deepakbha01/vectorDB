import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { InferencePattern } from './inference-architecture.types';

export const INFERENCE_PATTERNS: InferencePattern[] = ['synchronous', 'streaming', 'asynchronous', 'batch', 'real_time'];

/** Everything is optional: blanks are derived from the inference assessment, Workload Profile and Discovery. */
export class CreateInferenceArchitectureDto {
  @ApiProperty({ required: false, enum: INFERENCE_PATTERNS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(INFERENCE_PATTERNS, { each: true })
  patterns?: InferencePattern[];

  @ApiProperty({ required: false, description: 'A Kubernetes platform is available to run serving on' })
  @IsOptional()
  @IsBoolean()
  hasKubernetes?: boolean;

  @ApiProperty({ required: false, description: 'GPUs are available (or can be provisioned) for self-hosted serving' })
  @IsOptional()
  @IsBoolean()
  hasGpu?: boolean;
}
