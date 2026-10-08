import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, ValidateIf } from 'class-validator';

/** Phase 3 - the architect's toggles (spec 4.4). Omitted fields use the rules' defaults. */
export class GenerateArchitectureDto {
  @ApiProperty({ required: false, nullable: true, description: 'API Management gateway; null lets the rules decide' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsBoolean()
  apiGateway?: boolean | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  chatHistory?: boolean;

  @ApiProperty({ required: false, enum: ['auto', 'payg', 'ptu'] })
  @IsOptional()
  @IsIn(['auto', 'payg', 'ptu'])
  deployment?: 'auto' | 'payg' | 'ptu';
}
