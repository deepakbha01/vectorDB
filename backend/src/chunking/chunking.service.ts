import { BadRequestException, Injectable } from '@nestjs/common';
import { ChunkingStrategy } from './enums/chunking-strategy.enum';
import { ChunkingConfigDto } from './dto/chunking-config.dto';
import { Chunk, ChunkingResult, ChunkingStats } from './chunking.types';

interface Piece {
  text: string;
  start: number;
  end: number;
}

interface WordToken {
  start: number;
  end: number;
}

/**
 * Implements every chunking strategy required by Phase 2 - Design: Data &
 * Embedding Strategy (fixed-size, token-based, sentence-based,
 * paragraph-based, recursive, semantic, sliding-window).
 *
 * No dependency on a real subword tokenizer is introduced here - token counts
 * are approximated from word counts (see `approxTokenCount`). Phase 5's
 * ingestion pipeline will call the actual embedding provider's tokenizer for
 * exact counts; this service exists to let architects compare strategies at
 * Design time, independent of any provider.
 */
@Injectable()
export class ChunkingService {
  chunk(text: string, config: ChunkingConfigDto): ChunkingResult {
    this.validateConfig(config);
    const minChunkSize = config.minChunkSize ?? 1;
    const maxChunkSize = config.maxChunkSize ?? Number.MAX_SAFE_INTEGER;

    let ranges: Array<[number, number]>;
    const notes: string[] = [];

    switch (config.strategy) {
      case ChunkingStrategy.FIXED_SIZE:
        ranges = this.windowIndicesRange(0, text.length, config.chunkSize, config.chunkOverlap, false);
        notes.push('Fixed-size: character windows of chunkSize with chunkOverlap character overlap.');
        break;

      case ChunkingStrategy.SLIDING_WINDOW:
        ranges = this.windowIndicesRange(0, text.length, config.chunkSize, config.chunkOverlap, true);
        notes.push('Sliding-window: character windows anchored so the final window always ends exactly at the text end.');
        break;

      case ChunkingStrategy.TOKEN_BASED: {
        const words = this.wordTokens(text);
        const wordRanges = this.windowIndicesRange(0, words.length, config.chunkSize, config.chunkOverlap, false);
        ranges = wordRanges.map(([s, e]) => [words[s]?.start ?? 0, words[Math.max(s, e - 1)]?.end ?? text.length]);
        notes.push('Token-based: chunkSize/chunkOverlap are interpreted as word counts (a proxy for subword tokens).');
        break;
      }

      case ChunkingStrategy.SENTENCE_BASED:
        ranges = this.mergePieces(this.splitSentences(text), config.chunkSize, config.chunkOverlap, maxChunkSize);
        notes.push('Sentence-based: sentences are greedily grouped up to chunkSize characters.');
        break;

      case ChunkingStrategy.PARAGRAPH_BASED:
        ranges = this.mergePieces(this.splitParagraphs(text), config.chunkSize, config.chunkOverlap, maxChunkSize);
        notes.push('Paragraph-based: paragraphs (blank-line separated) are greedily grouped up to chunkSize characters.');
        break;

      case ChunkingStrategy.RECURSIVE:
        ranges = this.recursiveSplit(text, config.chunkSize, config.chunkOverlap, maxChunkSize);
        notes.push('Recursive: splits by paragraph, falls back to sentence, then fixed-size windows for any piece still over maxChunkSize.');
        break;

      case ChunkingStrategy.SEMANTIC:
        ranges = this.mergePieces(this.splitSentences(text), config.chunkSize, config.chunkOverlap, maxChunkSize);
        notes.push(
          'Semantic (heuristic): approximated via sentence-boundary grouping. True embedding-similarity boundary ' +
            'detection requires a live embedding provider call and is planned for the Phase 5 ingestion pipeline.',
        );
        break;

      default:
        throw new BadRequestException(`Unsupported chunking strategy: ${config.strategy}`);
    }

    ranges = this.mergeUndersizedTail(ranges, minChunkSize, maxChunkSize);

    const chunks: Chunk[] = ranges.map(([start, end], index) => {
      const chunkText = text.slice(start, end);
      return {
        index,
        text: chunkText,
        charStart: start,
        charEnd: end,
        approxTokenCount: this.approxTokenCount(chunkText),
      };
    });

    return { chunks, stats: this.computeStats(chunks), notes };
  }

  validateConfig(config: ChunkingConfigDto): void {
    if (config.chunkOverlap >= config.chunkSize) {
      throw new BadRequestException('chunkOverlap must be smaller than chunkSize.');
    }
    if (config.minChunkSize && config.maxChunkSize && config.minChunkSize > config.maxChunkSize) {
      throw new BadRequestException('minChunkSize cannot be greater than maxChunkSize.');
    }
    if (config.maxChunkSize && config.chunkSize > config.maxChunkSize) {
      throw new BadRequestException('chunkSize cannot be greater than maxChunkSize.');
    }
  }

  private approxTokenCount(text: string): number {
    const wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    return Math.ceil(wordCount * 1.3);
  }

  private computeStats(chunks: Chunk[]): ChunkingStats {
    if (chunks.length === 0) {
      return { count: 0, avgSizeChars: 0, minSizeChars: 0, maxSizeChars: 0 };
    }
    const sizes = chunks.map((c) => c.text.length);
    return {
      count: chunks.length,
      avgSizeChars: Number((sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1)),
      minSizeChars: Math.min(...sizes),
      maxSizeChars: Math.max(...sizes),
    };
  }

  /** Generic windowing over any linear index space (characters or word indices). */
  private windowIndicesRange(
    rangeStart: number,
    rangeEnd: number,
    size: number,
    overlap: number,
    anchorLastToEnd: boolean,
  ): Array<[number, number]> {
    const length = rangeEnd - rangeStart;
    if (length <= 0) {
      return [];
    }
    const step = Math.max(1, size - overlap);
    const windows: Array<[number, number]> = [];
    let i = 0;
    while (i < length) {
      const start = rangeStart + i;
      const end = Math.min(rangeStart + i + size, rangeEnd);
      windows.push([start, end]);
      if (end >= rangeEnd) break;
      i += step;
    }
    if (anchorLastToEnd && windows.length > 1) {
      const [lastStart, lastEnd] = windows[windows.length - 1];
      if (lastEnd - lastStart < size && rangeEnd - size >= rangeStart) {
        windows[windows.length - 1] = [rangeEnd - size, rangeEnd];
      }
    }
    return windows;
  }

  private wordTokens(text: string): WordToken[] {
    const tokens: WordToken[] = [];
    const re = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      tokens.push({ start: match.index, end: match.index + match[0].length });
    }
    return tokens;
  }

  private splitSentences(text: string): Piece[] {
    const pieces: Piece[] = [];
    const re = /[^.!?]+[.!?]+/g;
    let match: RegExpExecArray | null;
    let lastEnd = 0;
    while ((match = re.exec(text)) !== null) {
      pieces.push({ text: match[0], start: match.index, end: match.index + match[0].length });
      lastEnd = match.index + match[0].length;
    }
    if (lastEnd < text.length && text.slice(lastEnd).trim().length > 0) {
      pieces.push({ text: text.slice(lastEnd), start: lastEnd, end: text.length });
    }
    return pieces.length > 0 ? pieces : [{ text, start: 0, end: text.length }];
  }

  private splitParagraphs(text: string): Piece[] {
    const pieces: Piece[] = [];
    const re = /\n\s*\n+/g;
    let match: RegExpExecArray | null;
    let lastEnd = 0;
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastEnd) {
        pieces.push({ text: text.slice(lastEnd, match.index), start: lastEnd, end: match.index });
      }
      lastEnd = re.lastIndex;
    }
    if (lastEnd < text.length) {
      pieces.push({ text: text.slice(lastEnd), start: lastEnd, end: text.length });
    }
    return pieces.length > 0 ? pieces : [{ text, start: 0, end: text.length }];
  }

  /** Greedily groups contiguous pieces into chunks of ~chunkSize characters, carrying `chunkOverlap` characters forward. */
  private mergePieces(pieces: Piece[], chunkSize: number, chunkOverlap: number, maxChunkSize: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let buffer: Piece[] = [];

    const flush = () => {
      if (buffer.length === 0) return;
      ranges.push([buffer[0].start, buffer[buffer.length - 1].end]);
      if (chunkOverlap > 0) {
        const carry: Piece[] = [];
        let carryLen = 0;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const len = buffer[i].end - buffer[i].start;
          if (carryLen + len > chunkOverlap) break;
          carry.unshift(buffer[i]);
          carryLen += len;
        }
        buffer = carry;
      } else {
        buffer = [];
      }
    };

    for (const piece of pieces) {
      const pieceLen = piece.end - piece.start;
      if (pieceLen > maxChunkSize) {
        flush();
        buffer = [];
        for (const [s, e] of this.windowIndicesRange(piece.start, piece.end, chunkSize, chunkOverlap, false)) {
          ranges.push([s, e]);
        }
        continue;
      }
      const projected = buffer.length > 0 ? piece.end - buffer[0].start : pieceLen;
      if (buffer.length > 0 && projected > chunkSize) {
        flush();
      }
      buffer.push(piece);
    }
    flush();
    return ranges;
  }

  /** Paragraph -> sentence -> fixed-size cascade, then greedy merge (no piece exceeds maxChunkSize going in). */
  private recursiveSplit(text: string, chunkSize: number, chunkOverlap: number, maxChunkSize: number): Array<[number, number]> {
    const paragraphs = this.splitParagraphs(text);
    const expanded: Piece[] = [];

    for (const paragraph of paragraphs) {
      if (paragraph.end - paragraph.start <= maxChunkSize) {
        expanded.push(paragraph);
        continue;
      }
      const sentences = this.splitSentences(text.slice(paragraph.start, paragraph.end)).map((s) => ({
        text: s.text,
        start: s.start + paragraph.start,
        end: s.end + paragraph.start,
      }));
      for (const sentence of sentences) {
        if (sentence.end - sentence.start <= maxChunkSize) {
          expanded.push(sentence);
        } else {
          for (const [s, e] of this.windowIndicesRange(sentence.start, sentence.end, chunkSize, chunkOverlap, false)) {
            expanded.push({ text: text.slice(s, e), start: s, end: e });
          }
        }
      }
    }

    return this.mergePieces(expanded, chunkSize, chunkOverlap, maxChunkSize);
  }

  /** Folds a final chunk smaller than minChunkSize into its predecessor when that would not exceed maxChunkSize. */
  private mergeUndersizedTail(ranges: Array<[number, number]>, minChunkSize: number, maxChunkSize: number): Array<[number, number]> {
    if (ranges.length < 2) {
      return ranges;
    }
    const result = [...ranges];
    const last = result[result.length - 1];
    const secondLast = result[result.length - 2];
    const lastSize = last[1] - last[0];
    const combinedSize = last[1] - secondLast[0];
    if (lastSize < minChunkSize && combinedSize <= maxChunkSize) {
      result.splice(result.length - 2, 2, [secondLast[0], last[1]]);
    }
    return result;
  }
}
