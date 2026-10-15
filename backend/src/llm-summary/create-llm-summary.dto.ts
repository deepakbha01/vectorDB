import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { LLM_SUMMARY_AUDIENCES, LlmSummaryAudience } from './llm-summary.prompt';

export class CreateLlmSummaryDto {
  @ApiPropertyOptional({ enum: LLM_SUMMARY_AUDIENCES, default: 'executive' })
  @IsOptional()
  @IsIn(LLM_SUMMARY_AUDIENCES)
  audience?: LlmSummaryAudience;
}
