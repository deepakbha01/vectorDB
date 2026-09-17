export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  approxTokenCount: number;
}

export interface ChunkingStats {
  count: number;
  avgSizeChars: number;
  minSizeChars: number;
  maxSizeChars: number;
}

export interface ChunkingResult {
  chunks: Chunk[];
  stats: ChunkingStats;
  notes: string[];
}
