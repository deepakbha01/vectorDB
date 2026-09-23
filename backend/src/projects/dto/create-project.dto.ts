import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CustomerMode } from '../enums/customer-mode.enum';

export class CreateProjectDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  businessUseCase?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  industry?: string;

  @ApiProperty({ required: false, description: 'AI Factory Pattern Library entry id to seed Discovery defaults from (optional).' })
  @IsOptional()
  @IsString()
  patternId?: string;

  @ApiProperty({ enum: CustomerMode, required: false, description: 'Defaults to "new" (greenfield) when omitted.' })
  @IsOptional()
  @IsEnum(CustomerMode)
  customerMode?: CustomerMode;
}
