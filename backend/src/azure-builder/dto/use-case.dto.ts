import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SOLUTION_PATTERNS } from '../use-case-spec';

const USER_TYPES = ['internal', 'external', 'mixed'];
const CHANNELS = ['web', 'teams', 'mobile', 'api', 'email'];
const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'];
const REFRESH = ['static', 'weekly', 'daily', 'hourly', 'realtime'];
const ENVIRONMENTS = ['dev', 'test', 'prod'];

export class BusinessDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(2000) problem: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(200, { each: true }) kpis: string[];
  @ApiProperty() @IsString() @MaxLength(120) sponsor: string;
  @ApiProperty() @IsString() @MaxLength(60) costCenter: string;
}

export class UsersDto {
  @ApiProperty({ enum: USER_TYPES }) @IsIn(USER_TYPES) type: 'internal' | 'external' | 'mixed';
  @ApiProperty() @IsInt() @Min(0) count: number;
  @ApiProperty() @IsInt() @Min(0) peakConcurrent: number;
  @ApiProperty({ enum: CHANNELS, isArray: true }) @IsArray() @IsIn(CHANNELS, { each: true }) channels: Array<'web' | 'teams' | 'mobile' | 'api' | 'email'>;
}

export class DataSourceDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) source: string;
  @ApiProperty() @IsString() @MaxLength(80) format: string;
  @ApiProperty() @IsNumber() @Min(0) volumeGb: number;
  @ApiProperty({ enum: CLASSIFICATIONS }) @IsIn(CLASSIFICATIONS) classification: 'public' | 'internal' | 'confidential' | 'restricted';
  @ApiProperty() @IsBoolean() containsPersonalData: boolean;
  @ApiProperty({ enum: REFRESH }) @IsIn(REFRESH) refresh: 'static' | 'weekly' | 'daily' | 'hourly' | 'realtime';
}

export class ConstraintsDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) regions: string[];
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(60) dataResidency: string | null;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) compliance: string[];
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsNumber() @Min(1) latencyMs: number | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(10) availability: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsNumber() @Min(0) monthlyBudgetUsd: number | null;
}

/** Phase 2 - the wizard's answers (spec 4.3 steps: Business, Users, Data, Constraints). */
export class CreateUseCaseDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(120) name: string;
  @ApiProperty({ type: BusinessDto }) @ValidateNested() @Type(() => BusinessDto) business: BusinessDto;
  @ApiProperty({ type: UsersDto }) @ValidateNested() @Type(() => UsersDto) users: UsersDto;
  @ApiProperty({ type: [DataSourceDto] }) @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => DataSourceDto) data: DataSourceDto[];
  @ApiProperty({ type: ConstraintsDto }) @ValidateNested() @Type(() => ConstraintsDto) constraints: ConstraintsDto;
  @ApiProperty({ enum: ENVIRONMENTS }) @IsIn(ENVIRONMENTS) environment: 'dev' | 'test' | 'prod';
}

/** An architect's override of the classified pattern (spec 4.3: the override is recorded). */
export class OverridePatternDto {
  @ApiProperty({ enum: SOLUTION_PATTERNS.map((p) => p.id) }) @IsIn(SOLUTION_PATTERNS.map((p) => p.id)) pattern: string;
  @ApiProperty() @IsString() @MinLength(10, { message: 'Give a reason of at least 10 characters for the override' }) @MaxLength(500) reason: string;
}
