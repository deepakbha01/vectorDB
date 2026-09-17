import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ChunkingConfigDto } from './chunking-config.dto';

export class ChunkingPreviewDto {
  @ApiProperty({ description: 'Sample document text to chunk, for previewing strategy behavior.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200_000)
  text: string;

  @ApiProperty({ type: ChunkingConfigDto })
  @ValidateNested()
  @Type(() => ChunkingConfigDto)
  config: ChunkingConfigDto;
}
