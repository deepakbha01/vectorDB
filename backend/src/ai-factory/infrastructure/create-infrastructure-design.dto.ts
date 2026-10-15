import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Keys of estateStorageVendors / estateHypervisors in config/infrastructure-targets.yaml. */
export const ESTATE_STORAGE_VENDORS = ['netapp', 'nutanix', 'dell_emc', 'vast_data', 'ddn', 'other'];
export const ESTATE_HYPERVISORS = ['vmware', 'nutanix_ahv', 'hyper_v', 'none'];

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

  @ApiProperty({ required: false, description: 'The on-premises data centre has direct-to-chip liquid cooling (needed by rack-scale systems such as GB300 NVL72)' })
  @IsOptional()
  @IsBoolean()
  liquidCooling?: boolean;

  @ApiProperty({ required: false, description: 'Most power the data centre can deliver to one rack (kW)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(2000)
  maxRackPowerKw?: number;

  @ApiProperty({ required: false, isArray: true, enum: ESTATE_STORAGE_VENDORS, description: 'Storage vendors already run on-premises (reuse scores higher)' })
  @IsOptional()
  @IsArray()
  @IsIn(ESTATE_STORAGE_VENDORS, { each: true })
  existingStorageVendors?: string[];

  @ApiProperty({ required: false, enum: ESTATE_HYPERVISORS, description: 'Hypervisor already run on-premises' })
  @IsOptional()
  @IsIn(ESTATE_HYPERVISORS)
  existingHypervisor?: string;

  @ApiProperty({ required: false, enum: ['none', 'adapter', 'full'], description: 'Fine-tuning on-premises (default: Model Selection)' })
  @IsOptional()
  @IsIn(['none', 'adapter', 'full'])
  fineTuning?: 'none' | 'adapter' | 'full';
}
