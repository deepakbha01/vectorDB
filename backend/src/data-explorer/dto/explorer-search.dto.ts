import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

/** A search in the Data Explorer: text (embedded with the project's model) or a raw vector. */
export class ExplorerSearchDto {
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8192)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  vector?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;

  /** Exact matches on metadata fields, e.g. { "department": "legal" }. */
  @IsOptional()
  @IsObject()
  filter?: Record<string, string | number | boolean>;
}

/** Paging through records. */
export class ExplorerDocumentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Opaque cursor from the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** JSON object of field → value, e.g. {"department":"legal"}. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  filter?: string;
}
