import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Phase 7 - a monthly cost budget on the deployment's resource group (alerts at 80% and 100%). */
export class SetBudgetDto {
  @ApiProperty({ required: false, description: 'Monthly amount in the billing currency; defaults to the use case budget, else the estimate.' })
  @IsOptional() @IsNumber() @Min(1) @Max(10_000_000) amountUsd?: number;

  @ApiProperty({ required: false, type: [String], description: 'Who gets the alerts; defaults to the signed-in Azure user.' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsEmail({}, { each: true }) contactEmails?: string[];
}

/** Phase 7 - teardown, confirmed by typing the environment name. */
export class TeardownDto {
  @ApiProperty({ example: 'dev' }) @IsString() @MaxLength(10) confirm: string;
}
