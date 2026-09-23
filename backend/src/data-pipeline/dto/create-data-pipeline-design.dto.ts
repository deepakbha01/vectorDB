import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ChunkingConfigDto } from '../../chunking/dto/chunking-config.dto';
import { MetadataFieldDto } from './metadata-field.dto';
import { DimensionMismatchReason } from '../data-pipeline-design.types';

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

  @ApiProperty({
    required: false,
    description:
      'Set to true to proceed despite a detected mismatch between the selected model\'s dimension and the Discovery ' +
      'assessment\'s estimated embedding dimension. Submitting with a mismatch and this unset returns a ' +
      "DIMENSION_MISMATCH_CONFIRMATION_REQUIRED error instead of silently proceeding.",
  })
  @IsOptional()
  @IsBoolean()
  dimensionMismatchAcknowledged?: boolean;

  @ApiProperty({ enum: DimensionMismatchReason, required: false })
  @IsOptional()
  @IsEnum(DimensionMismatchReason)
  dimensionMismatchReason?: DimensionMismatchReason;
}
