import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { DocumentInputDto } from './document-input.dto';
import { IngestionConfigOverrideDto } from './ingestion-config-override.dto';

export class CreateIngestionRunDto {
  @ApiProperty({ type: [DocumentInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => DocumentInputDto)
  documents: DocumentInputDto[];

  @ApiProperty({ type: IngestionConfigOverrideDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => IngestionConfigOverrideDto)
  config?: IngestionConfigOverrideDto;
}
