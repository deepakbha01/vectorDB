import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ChunkingStrategy } from '../enums/chunking-strategy.enum';

/**
 * `chunkSize`/`chunkOverlap` are interpreted as characters for FIXED_SIZE,
 * SENTENCE_BASED, PARAGRAPH_BASED, RECURSIVE, and SEMANTIC, and as words for
 * TOKEN_BASED and SLIDING_WINDOW (see ChunkingService for the exact unit per
 * strategy - a real subword tokenizer is out of scope until an embedding
 * provider is wired in during Phase 5 ingestion).
 */
export class ChunkingConfigDto {
  @ApiProperty({ enum: ChunkingStrategy })
  @IsEnum(ChunkingStrategy)
  strategy: ChunkingStrategy;

  @ApiProperty()
  @IsInt()
  @Min(1)
  chunkSize: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  chunkOverlap: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  minChunkSize?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxChunkSize?: number;
}
