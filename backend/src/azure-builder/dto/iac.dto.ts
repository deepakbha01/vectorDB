import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

/** Values the generator will not invent, for one environment. Format and overlap checks run in the service. */
export class EnvInputsDto {
  @ApiProperty({ required: false, example: '10.20.0.0/22' }) @IsOptional() @IsString() @MaxLength(18) vnetAddressPrefix?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(300) privateDnsZoneResourceGroupId?: string;
  @ApiProperty({ required: false, example: 'myacr.azurecr.io/assistant-api:1.0.0' }) @IsOptional() @IsString() @MaxLength(300) containerImage?: string;
}

export class IacInputsDto {
  @ApiProperty({ required: false, type: EnvInputsDto }) @IsOptional() @ValidateNested() @Type(() => EnvInputsDto) dev?: EnvInputsDto;
  @ApiProperty({ required: false, type: EnvInputsDto }) @IsOptional() @ValidateNested() @Type(() => EnvInputsDto) test?: EnvInputsDto;
  @ApiProperty({ required: false, type: EnvInputsDto }) @IsOptional() @ValidateNested() @Type(() => EnvInputsDto) prod?: EnvInputsDto;
}

/** Phase 4 - optional workload name and required-input values; omitted inputs carry over from the previous bundle. */
export class GenerateIacDto {
  @ApiProperty({ required: false, example: 'hrpolicy', description: '2-12 lower-case letters and digits, starting with a letter' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9]{1,11}$/, { message: 'The workload name must be 2-12 lower-case letters and digits, starting with a letter.' })
  workload?: string;

  @ApiProperty({ required: false, type: IacInputsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => IacInputsDto)
  inputs?: IacInputsDto;
}
