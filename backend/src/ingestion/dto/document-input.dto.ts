import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class DocumentInputDto {
  @ApiProperty({ required: false, description: 'Stable source ID; used to build the idempotency key. Auto-generated if omitted.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  id?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500_000)
  text: string;

  @ApiProperty({ type: Object })
  @IsObject()
  metadata: Record<string, unknown>;
}
