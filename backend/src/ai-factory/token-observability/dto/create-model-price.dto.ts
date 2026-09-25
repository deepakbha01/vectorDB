import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { PriceTokenType } from '../model-price.entity';

const TOKEN_TYPES: PriceTokenType[] = ['input', 'output', 'cached_input', 'reasoning', 'embedding', 'reranking'];

/** A contracted price for one project (spec §13). */
export class CreateModelPriceDto {
  @IsString()
  @Length(1, 100)
  provider: string;

  @IsString()
  @Length(1, 200)
  model: string;

  @IsIn(TOKEN_TYPES)
  tokenType: PriceTokenType;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Max(1_000_000)
  pricePer1M: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /** Defaults to now. */
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsString()
  @Length(1, 300)
  source: string;
}
