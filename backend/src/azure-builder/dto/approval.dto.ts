import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RAI_CHECKLIST } from '../validate-approve';

const ENVS = ['dev', 'test', 'prod'];

/** Phase 5 - run a what-if for one environment: the offline plan, a pasted ARM what-if, or a live one run with the user's Azure sign-in (X-Azure-Token header). */
export class RunWhatIfDto {
  @ApiProperty({ enum: ENVS }) @IsIn(ENVS) environment: 'dev' | 'test' | 'prod';
  @ApiProperty({ enum: ['planned', 'arm', 'live'] }) @IsIn(['planned', 'arm', 'live']) source: 'planned' | 'arm' | 'live';
  @ApiProperty({ required: false, description: 'Output of az deployment group what-if --no-pretty-print (source: arm)' })
  @IsOptional() @IsString() @MaxLength(5_000_000) result?: string;
}

/** Phase 6 - deploy one environment of the latest approved bundle (the Azure sign-in travels in the X-Azure-Token header). */
export class CreateDeploymentDto {
  @ApiProperty({ enum: ENVS }) @IsIn(ENVS) environment: 'dev' | 'test' | 'prod';
}

/** Phase 5 - an approval or rejection. Rejections need a reason. */
export class CreateApprovalDto {
  @ApiProperty({ enum: ENVS }) @IsIn(ENVS) environment: 'dev' | 'test' | 'prod';
  @ApiProperty({ enum: ['approved', 'rejected'] }) @IsIn(['approved', 'rejected']) decision: 'approved' | 'rejected';
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2000) comments?: string;
  @ApiProperty({ required: false, type: [String], enum: RAI_CHECKLIST.map((r) => r.id) })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(RAI_CHECKLIST.map((r) => r.id), { each: true }) raiChecklist?: string[];
}
