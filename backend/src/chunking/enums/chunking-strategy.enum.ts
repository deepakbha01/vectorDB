/**
 * All chunking strategies required by Phase 2 - Design: Data & Embedding Strategy.
 */
export enum ChunkingStrategy {
  FIXED_SIZE = 'fixed_size',
  TOKEN_BASED = 'token_based',
  SENTENCE_BASED = 'sentence_based',
  PARAGRAPH_BASED = 'paragraph_based',
  RECURSIVE = 'recursive',
  SEMANTIC = 'semantic',
  SLIDING_WINDOW = 'sliding_window',
}
