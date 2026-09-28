import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Edits the business use case after the project was created. Empty clears a field. */
export class UpdateUseCaseDto {
  @ApiProperty({ description: 'The business use case. An empty string clears it.' })
  @IsString()
  @MaxLength(4000)
  businessUseCase: string;

  @ApiProperty({ required: false, description: 'Leave out to keep the current industry; an empty string clears it.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  industry?: string;
}
