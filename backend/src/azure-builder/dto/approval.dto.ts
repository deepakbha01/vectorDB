import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RAI_CHECKLIST } from '../validate-approve';

const ENVS = ['dev', 'test', 'prod'];

/** Phase 5 - run a what-if for one environment: the offline plan, or a pasted ARM what-if. */
export class RunWhatIfDto {
  @ApiProperty({ enum: ENVS }) @IsIn(ENVS) environment: 'dev' | 'test' | 'prod';
  @ApiProperty({ enum: ['planned', 'arm'] }) @IsIn(['planned', 'arm']) source: 'planned' | 'arm';
  @ApiProperty({ required: false, description: 'Output of az deployment group what-if --no-pretty-print (source: arm)' })
  @IsOptional() @IsString() @MaxLength(5_000_000) result?: string;
}

/** Phase 5 - an approval or rejection. Rejections need a reason. */
export class CreateApprovalDto {
  @ApiProperty({ enum: ENVS }) @IsIn(ENVS) environment: 'dev' | 'test' | 'prod';
  @ApiProperty({ enum: ['approved', 'rejected'] }) @IsIn(['approved', 'rejected']) decision: 'approved' | 'rejected';
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2000) comments?: string;
  @ApiProperty({ required: false, type: [String], enum: RAI_CHECKLIST.map((r) => r.id) })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(RAI_CHECKLIST.map((r) => r.id), { each: true }) raiChecklist?: string[];
}
