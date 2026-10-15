import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { LLM_PROVIDERS } from './llm-client.service';

const PROVIDER_IDS = Object.keys(LLM_PROVIDERS);

export class CreateLlmConnectionDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80)
  name: string;

  @ApiProperty({ enum: PROVIDER_IDS }) @IsIn(PROVIDER_IDS)
  provider: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200)
  model: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  baseUrl?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40)
  apiVersion?: string;

  /** Write-only. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000)
  apiKey?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isDefault?: boolean;
}

/** Every field optional; an omitted apiKey keeps the stored one, '' clears it. */
export class UpdateLlmConnectionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: PROVIDER_IDS }) @IsOptional() @IsIn(PROVIDER_IDS)
  provider?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  model?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  baseUrl?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40)
  apiVersion?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000)
  apiKey?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isDefault?: boolean;
}
