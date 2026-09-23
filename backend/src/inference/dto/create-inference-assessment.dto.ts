import { ApiProperty } from '@nestjs/swagger';
import {
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
  ValidateIf,
} from 'class-validator';
import { GpuPricingModel, InferenceOpsCapability, InferenceWorkloadType, ModelSourcing } from '../inference.types';

export const CUSTOM_MODEL_ID = 'custom';

/**
 * Inference-as-a-Service discovery intake. Model, GPU, precision and API tier
 * ids refer to config/inference.yaml (GET /projects/:id/inference/catalogue).
 */
export class CreateInferenceAssessmentDto {
  // ---- workload
  @ApiProperty({ enum: InferenceWorkloadType })
  @IsEnum(InferenceWorkloadType)
  workloadType: InferenceWorkloadType;

  @ApiProperty({ enum: ModelSourcing, description: 'Whether self-hosted open-weight serving, a managed API, or both are in scope' })
  @IsEnum(ModelSourcing)
  modelSourcing: ModelSourcing;

  @ApiProperty({ description: 'Average requests (model calls) per day' })
  @IsNumber()
  @Min(1)
  requestsPerDay: number;

  @ApiProperty({ description: 'Peak-hour request rate ÷ daily average rate', default: 3 })
  @IsNumber()
  @Min(1)
  @Max(50)
  peakToAverageRatio: number;

  @ApiProperty({ description: 'Average prompt tokens per request (system prompt + user input + any retrieved RAG context)' })
  @IsInt()
  @Min(1)
  avgInputTokens: number;

  @ApiProperty({ description: 'Average generated tokens per request' })
  @IsInt()
  @Min(1)
  avgOutputTokens: number;

  @ApiProperty({ description: 'Longest request (input + output) that must be served' })
  @IsInt()
  @Min(1)
  maxContextTokens: number;

  @ApiProperty({ required: false, description: 'Compound monthly growth in request volume (%)', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  monthlyGrowthPercent?: number;

  // ---- latency SLOs
  @ApiProperty({ description: 'Time-to-first-token target (ms)' })
  @IsNumber()
  @Min(50)
  ttftTargetMs: number;

  @ApiProperty({ description: 'Time-per-output-token target (ms). 50 ms ≈ 20 tokens/s per user.' })
  @IsNumber()
  @Min(5)
  tpotTargetMs: number;

  @ApiProperty({ description: 'Service availability target (%)' })
  @IsNumber()
  @Min(90)
  @Max(99.999)
  availabilityTargetPercent: number;

  // ---- self-hosted model
  @ApiProperty({ description: `Catalogue model id, or '${CUSTOM_MODEL_ID}' to describe the architecture below` })
  @IsString()
  modelId: string;

  @ApiProperty({ required: false, description: "Serving precision id, or 'auto' (evaluates FP16 and FP8)", default: 'auto' })
  @IsOptional()
  @IsString()
  precision?: string;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.modelId === CUSTOM_MODEL_ID)
  @IsString()
  @MaxLength(80)
  customModelName?: string;

  @ApiProperty({ required: false, description: 'Total parameters (billions)' })
  @ValidateIf((o) => o.modelId === CUSTOM_MODEL_ID)
  @IsNumber()
  @Min(0.1)
  customParamsB?: number;

  @ApiProperty({ required: false, description: 'Active parameters per token (billions) - differs from total only for MoE models' })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  customActiveParamsB?: number;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.modelId === CUSTOM_MODEL_ID)
  @IsInt()
  @Min(1)
  customLayers?: number;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.modelId === CUSTOM_MODEL_ID)
  @IsInt()
  @Min(1)
  customKvHeads?: number;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.modelId === CUSTOM_MODEL_ID)
  @IsInt()
  @Min(1)
  customHeadDim?: number;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.modelId === CUSTOM_MODEL_ID)
  @IsInt()
  @Min(512)
  customMaxContextTokens?: number;

  // ---- GPU / hosting
  @ApiProperty({ required: false, isArray: true, description: 'Restrict to these catalogue GPU ids (e.g. what the cloud region or data centre offers). Empty = all.' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  allowedGpuIds?: string[];

  @ApiProperty({ enum: GpuPricingModel, required: false, default: GpuPricingModel.ON_DEMAND })
  @IsOptional()
  @IsEnum(GpuPricingModel)
  gpuPricing?: GpuPricingModel;

  @ApiProperty({ required: false, default: true, description: 'Scale replicas with load (otherwise provisioned for peak 24x7)' })
  @IsOptional()
  @IsBoolean()
  autoscaling?: boolean;

  @ApiProperty({ enum: InferenceOpsCapability })
  @IsEnum(InferenceOpsCapability)
  opsCapability: InferenceOpsCapability;

  // ---- managed API
  @ApiProperty({ description: 'Managed API price tier id used for the comparison' })
  @IsString()
  managedApiTierId: string;

  @ApiProperty({ required: false, description: 'Contracted input price (USD per 1M tokens) - overrides the tier list price' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  apiInputPricePer1M?: number;

  @ApiProperty({ required: false, description: 'Contracted output price (USD per 1M tokens) - overrides the tier list price' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  apiOutputPricePer1M?: number;

  // ---- data & compliance
  @ApiProperty({ description: 'Prompts/responses may be sent to a third-party model API' })
  @IsBoolean()
  allowThirdPartyApi: boolean;

  @ApiProperty()
  @IsBoolean()
  containsPii: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  dataResidencyRequirement?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyBudgetUsd?: number;
}
