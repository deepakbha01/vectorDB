import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LLM_SUMMARY_AUDIENCES, LlmSummaryAudience } from './llm-summary.prompt';

export class CreateLlmSummaryDto {
  @ApiPropertyOptional({ enum: LLM_SUMMARY_AUDIENCES, default: 'executive' })
  @IsOptional()
  @IsIn(LLM_SUMMARY_AUDIENCES)
  audience?: LlmSummaryAudience;

  /** A saved LLM integration's id, or 'server' for the LLM_* settings. Omitted: the default integration. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  connectionId?: string;
}
