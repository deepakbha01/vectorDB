import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** A sparse query vector: 0-based indices and their weights, the same length. */
export class SparseVectorDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4096)
  @IsInt({ each: true })
  @Min(0, { each: true })
  indices!: number[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4096)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  values!: number[];
}

/**
 * A search in the Data Explorer. dense: text (embedded with the project's model)
 * or a raw vector. keyword: text ranked by the database. hybrid: text, run both
 * ways and fused by rank, weighted by alpha (1 = dense only, 0 = keyword only).
 */
export class ExplorerSearchDto {
  @IsOptional()
  @IsIn(['dense', 'keyword', 'hybrid'])
  mode?: 'dense' | 'keyword' | 'hybrid';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  alpha?: number;

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
  filter?: Record<string, unknown>;

  /** Named vectors (Qdrant, Weaviate): which one to use; default the first. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vectorName?: string;

  /** For a sparse vector space: the query as indices and weights (instead of text or vector). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SparseVectorDto)
  sparse?: SparseVectorDto;

  /** Tenant (Weaviate) or namespace (Pinecone) to read, where the collection has them. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partition?: string;

  /** Hybrid only: how to fuse. rrf (default) and weighted run here; native asks the database (Weaviate, Elasticsearch). */
  @IsOptional()
  @IsIn(['rrf', 'weighted', 'native'])
  fusion?: 'rrf' | 'weighted' | 'native';

  /** Drop results scoring below this (dense: similarity; keyword: its score; hybrid: the dense candidates, before fusion). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1_000_000)
  @Max(1_000_000)
  minScore?: number;
}

/** One side of an A/B comparison: how to search (the query itself is shared). */
export class CompareSideDto {
  @IsOptional()
  @IsIn(['dense', 'keyword', 'hybrid'])
  mode?: 'dense' | 'keyword' | 'hybrid';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  alpha?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;

  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;

  /** Named vectors (Qdrant, Weaviate): which one to use; default the first. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vectorName?: string;

  /** Hybrid only: how to fuse. rrf (default) and weighted run here; native asks the database (Weaviate, Elasticsearch). */
  @IsOptional()
  @IsIn(['rrf', 'weighted', 'native'])
  fusion?: 'rrf' | 'weighted' | 'native';

  /** Drop results scoring below this (dense: similarity; keyword: its score; hybrid: the dense candidates, before fusion). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1_000_000)
  @Max(1_000_000)
  minScore?: number;
}

/** The same query run two ways. */
export class ExplorerCompareDto {
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
  @ValidateNested()
  @Type(() => SparseVectorDto)
  sparse?: SparseVectorDto;

  /** Tenant (Weaviate) or namespace (Pinecone) to read, where the collection has them. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partition?: string;

  @ValidateNested()
  @Type(() => CompareSideDto)
  a!: CompareSideDto;

  @ValidateNested()
  @Type(() => CompareSideDto)
  b!: CompareSideDto;
}

/** The embedding map. */
export class ExplorerMapQueryDto {
  /** Records to sample (10-1,000; default 500). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(1000)
  sample?: number;

  @IsOptional()
  @IsIn(['pca', 'umap', 'tsne'])
  method?: 'pca' | 'umap' | 'tsne';

/** Tenant (Weaviate) or namespace (Pinecone) to read, where the collection has them. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partition?: string;

  /** 2 (default) or 3 dimensions. */
  @IsOptional()
  @Type(() => Number)
  @IsIn([2, 3])
  dims?: 2 | 3;

  /** Named vectors (Qdrant, Weaviate): which one to use; default the first. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vectorName?: string;

  /** A metadata field to colour points by. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  colorBy?: string;

  /** JSON object of field → value, e.g. {"department":"legal"}. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  filter?: string;
}

/** One record in full. */
export class ExplorerRecordQueryDto {
  /** Tenant (Weaviate) or namespace (Pinecone) to read, where the collection has them. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partition?: string;

  /** Named vectors (Qdrant, Weaviate): which one to use; default the first. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vectorName?: string;
}

/** The collection overview, for one tenant / namespace where it has them. */
export class ExplorerOverviewQueryDto {
  /** Tenant (Weaviate) or namespace (Pinecone) to read, where the collection has them. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partition?: string;
}

/** Paging through records. */
export class ExplorerDocumentsQueryDto {
  /** Sort by this metadata field (only where the database can order a listing). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

/** Tenant (Weaviate) or namespace (Pinecone) to read, where the collection has them. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  partition?: string;

  /** Several sort fields, most significant first: "year:desc,dept:asc" (up to three). Takes precedence over sortBy. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  sort?: string;

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
