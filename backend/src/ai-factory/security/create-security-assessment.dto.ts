import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Governance facts no earlier phase records. Everything else comes from the design records. */
export class CreateSecurityAssessmentDto {
  @ApiProperty({ required: false, description: 'A data processing agreement is signed with every external vendor that processes customer data' })
  @IsOptional()
  @IsBoolean()
  vendorDpaSigned?: boolean;

  @ApiProperty({ required: false, description: 'A business associate agreement (HIPAA) is signed with every external vendor that processes PHI' })
  @IsOptional()
  @IsBoolean()
  vendorBaaSigned?: boolean;
}
