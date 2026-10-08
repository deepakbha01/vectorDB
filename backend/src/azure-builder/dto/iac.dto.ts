import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** Phase 4 - optional workload name for CAF resource names; derived from the use case name when omitted. */
export class GenerateIacDto {
  @ApiProperty({ required: false, example: 'hrpolicy', description: '2-12 lower-case letters and digits, starting with a letter' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9]{1,11}$/, { message: 'The workload name must be 2-12 lower-case letters and digits, starting with a letter.' })
  workload?: string;
}
