import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { EstimateOverrides } from '../estimate-inputs';
import { LlmUsage } from '../token-observability.types';

/** User overrides of the estimation inputs (validation spec §1, §3). Absent = not overridden. */
export class EstimateOverridesDto implements EstimateOverrides {
  @IsOptional() @IsIn(['required', 'optional', 'none']) llmUsage?: LlmUsage;
  @IsOptional() @IsNumber() @Min(0) @Max(1e12) requestsPerDay?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e7) qps?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) utilizationPercent?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(31) operatingDaysPerMonth?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) llmRequestSharePercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) avgInputTokensPerRequest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) avgOutputTokensPerRequest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) systemPromptTokens?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) conversationHistoryTokens?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) retrievedContextTokens?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) queryTokens?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) embeddingTokensPerRequest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) rerankingTokensPerRequest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) llmCallsPerRequest?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(100) agentStepsPerRequest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500) retryRatePercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) cacheHitRatePercent?: number;
}

export class TokenEstimateInputsDto {
  /** Omitted: reuse the overrides saved with the latest estimate. `{}` clears them. */
  @IsOptional() @ValidateNested() @Type(() => EstimateOverridesDto) overrides?: EstimateOverridesDto;
}
