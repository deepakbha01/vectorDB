import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';

export class CreateBenchmarkDto {
  @ApiProperty({ required: false, description: 'Synthetic corpus size (defaults from config/thresholds.yaml).' })
  @IsOptional()
  @IsInt()
  @Min(10)
  sampleSize?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  queryCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  topK?: number;

  @ApiProperty({ required: false, type: [Number], description: 'Search-parameter values to compare (efSearch for HNSW, nprobe for IVF-Flat/PQ).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  variants?: number[];
}
