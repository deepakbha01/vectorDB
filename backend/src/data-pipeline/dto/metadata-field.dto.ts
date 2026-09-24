import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiProperty({ required: false, description: 'Defaults to true when omitted.' })
  @IsOptional()
  @IsBoolean()
  filterable?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  searchable?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  sortable?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
