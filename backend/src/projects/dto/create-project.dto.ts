import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
