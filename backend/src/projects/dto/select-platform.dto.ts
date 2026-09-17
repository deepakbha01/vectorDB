import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { VectorPlatform } from '../enums/platform.enum';

export class SelectPlatformDto {
  @ApiProperty({ enum: VectorPlatform })
  @IsEnum(VectorPlatform)
  platform: VectorPlatform;

  @ApiProperty({
    required: false,
    description:
      'Required when overriding the Recommendation Engine result manually, for auditability.',
  })
  @IsOptional()
  @IsString()
  rationale?: string;
}
