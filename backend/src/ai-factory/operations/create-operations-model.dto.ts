import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { OnCallCoverage } from './operations.types';

export const ON_CALL: OnCallCoverage[] = ['none', 'business_hours', '24x7'];

/** Operating facts no earlier phase records. Everything else comes from the design records. */
export class CreateOperationsModelDto {
  @ApiProperty({ required: false, enum: ON_CALL, description: 'On-call coverage the operations team can provide' })
  @IsOptional()
  @IsIn(ON_CALL)
  onCallCoverage?: OnCallCoverage;

  @ApiProperty({ required: false, description: 'Disaster recovery has been rehearsed end to end' })
  @IsOptional()
  @IsBoolean()
  drTested?: boolean;
}
