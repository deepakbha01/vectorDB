import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ToolAccess } from './rag-agent.types';

export const TOOL_ACCESS: ToolAccess[] = ['none', 'read_only', 'read_write', 'external_actions'];

/** Everything optional: blanks come from the Workload Profile, Discovery and the earlier design records. */
export class CreateRagAgentDesignDto {
  @ApiProperty({ required: false, description: 'Design the RAG layer (default: from the workload profile)' })
  @IsOptional()
  @IsBoolean()
  includeRag?: boolean;

  @ApiProperty({ required: false, description: 'Design the agent layer (default: from the workload profile)' })
  @IsOptional()
  @IsBoolean()
  includeAgent?: boolean;

  @ApiProperty({ required: false, description: 'Answers must cite their sources' })
  @IsOptional()
  @IsBoolean()
  citationsRequired?: boolean;

  @ApiProperty({ required: false, description: 'Conversational (multi-turn) sessions' })
  @IsOptional()
  @IsBoolean()
  multiTurn?: boolean;

  @ApiProperty({ required: false, enum: TOOL_ACCESS, description: 'What the agent tools can do' })
  @IsOptional()
  @IsIn(TOOL_ACCESS)
  toolAccess?: ToolAccess;

  @ApiProperty({ required: false, description: 'Agent tasks are open-ended rather than a known set of flows' })
  @IsOptional()
  @IsBoolean()
  openEndedTasks?: boolean;

  @ApiProperty({ required: false, description: 'Remember users across sessions' })
  @IsOptional()
  @IsBoolean()
  longTermMemory?: boolean;
}
