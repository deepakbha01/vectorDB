import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { MetadataFieldType } from '../../schema-generator/schema-generator.types';

const METADATA_FIELD_TYPES: MetadataFieldType[] = ['string', 'number', 'boolean', 'date', 'json'];

export class MetadataFieldDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ enum: METADATA_FIELD_TYPES })
  @IsIn(METADATA_FIELD_TYPES)
  type: MetadataFieldType;
}
