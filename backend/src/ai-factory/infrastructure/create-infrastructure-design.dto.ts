import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Everything optional: blanks come from the Workload Profile, Discovery and the inference records. */
export class CreateInfrastructureDesignDto {
  @ApiProperty({ required: false, description: 'An on-premises Kubernetes platform exists' })
  @IsOptional()
  @IsBoolean()
  hasKubernetes?: boolean;

  @ApiProperty({ required: false, description: 'GPUs are available on-premises' })
  @IsOptional()
  @IsBoolean()
  hasGpu?: boolean;

  @ApiProperty({ required: false, description: 'On-premises has two or more independent failure domains (sites / data halls)' })
  @IsOptional()
  @IsBoolean()
  multipleOnPremSites?: boolean;
}
