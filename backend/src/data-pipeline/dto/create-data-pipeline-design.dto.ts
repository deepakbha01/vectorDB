import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ChunkingConfigDto } from '../../chunking/dto/chunking-config.dto';
import { MetadataFieldDto } from './metadata-field.dto';

export class CreateDataPipelineDesignDto {
  @ApiProperty({ description: 'Target table/collection name (sanitized into a valid DB identifier).' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  collectionName: string;

  @ApiProperty({ type: ChunkingConfigDto })
  @ValidateNested()
  @Type(() => ChunkingConfigDto)
  chunking: ChunkingConfigDto;

  @ApiProperty()
  @IsString()
  embeddingProviderId: string;

  @ApiProperty()
  @IsString()
  embeddingModelId: string;

  @ApiProperty({ type: [MetadataFieldDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MetadataFieldDto)
  metadataFields: MetadataFieldDto[];
}
