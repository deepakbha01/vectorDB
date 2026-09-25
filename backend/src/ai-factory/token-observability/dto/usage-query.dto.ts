import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches } from 'class-validator';

const ID = /^[A-Za-z0-9_.:@/+=#-]+$/;

/** The global filters every Token Observability view shares (spec §4, §19). */
export class UsageQueryDto {
  /** Defaults to 30 days before `to`. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Defaults to now. */
  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Observed usage only; estimated figures come from the estimate endpoints. Defaults to live. */
  @IsOptional()
  @IsIn(['simulated', 'live'])
  mode?: 'simulated' | 'live';

  @IsOptional() @IsString() @Length(1, 100) @Matches(ID) environment?: string;
  @IsOptional() @IsString() @Length(1, 200) @Matches(ID) application?: string;
  @IsOptional() @IsString() @Length(1, 200) @Matches(ID) service?: string;
  @IsOptional() @IsString() @Length(1, 200) @Matches(ID) model?: string;
  @IsOptional() @IsString() @Length(1, 100) @Matches(ID) provider?: string;
  @IsOptional() @IsString() @Length(1, 200) @Matches(ID) tenant?: string;
  @IsOptional() @IsString() @Length(1, 200) @Matches(ID) workflow?: string;

  /** Trend bucket. */
  @IsOptional()
  @IsIn(['hour', 'day'])
  bucket?: 'hour' | 'day';
}
