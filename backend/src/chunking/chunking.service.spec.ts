import { BadRequestException } from '@nestjs/common';
import { ChunkingService } from './chunking.service';
import { ChunkingStrategy } from './enums/chunking-strategy.enum';
import { ChunkingConfigDto } from './dto/chunking-config.dto';

function config(overrides: Partial<ChunkingConfigDto>): ChunkingConfigDto {
  return { strategy: ChunkingStrategy.FIXED_SIZE, chunkSize: 100, chunkOverlap: 0, ...overrides } as ChunkingConfigDto;
}

describe('ChunkingService', () => {
  let service: ChunkingService;

  beforeEach(() => {
    service = new ChunkingService();
  });

  it('rejects an overlap greater than or equal to chunk size', () => {
    expect(() => service.chunk('hello world', config({ chunkSize: 10, chunkOverlap: 10 }))).toThrow(BadRequestException);
  });

  it('reconstructs the original text exactly for non-overlapping fixed-size chunks', () => {
    const text = 'a'.repeat(250);
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.FIXED_SIZE, chunkSize: 100, chunkOverlap: 0 }));
    expect(result.chunks.map((c) => c.text).join('')).toBe(text);
    expect(result.stats.count).toBe(3);
  });

  it('produces overlapping fixed-size chunks that share the requested overlap', () => {
    const text = '0123456789'.repeat(5); // 50 chars
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.FIXED_SIZE, chunkSize: 20, chunkOverlap: 5 }));
    const [first, second] = result.chunks;
    expect(first.text.slice(-5)).toBe(second.text.slice(0, 5));
  });

  it('sliding-window anchors the last window exactly to the end of the text', () => {
    const text = 'x'.repeat(47);
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.SLIDING_WINDOW, chunkSize: 20, chunkOverlap: 5 }));
    const last = result.chunks[result.chunks.length - 1];
    expect(last.charEnd).toBe(text.length);
    expect(last.text.length).toBe(20);
  });

  it('token-based chunking groups whole words and never splits a word', () => {
    const text = 'one two three four five six seven eight nine ten';
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.TOKEN_BASED, chunkSize: 3, chunkOverlap: 1 }));
    for (const chunk of result.chunks) {
      expect(chunk.text.startsWith(' ')).toBe(false);
      expect(chunk.text.trim()).toBe(chunk.text);
    }
  });

  it('sentence-based chunking keeps sentences intact', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.SENTENCE_BASED, chunkSize: 30, chunkOverlap: 0 }));
    for (const chunk of result.chunks) {
      expect(chunk.text.trim().endsWith('.')).toBe(true);
    }
  });

  it('paragraph-based chunking splits on blank lines', () => {
    const text = 'Para one line.\n\nPara two line.\n\nPara three line.';
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.PARAGRAPH_BASED, chunkSize: 15, chunkOverlap: 0 }));
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('recursive chunking keeps every chunk within maxChunkSize', () => {
    const longParagraph = 'Sentence number one is short. '.repeat(20); // one paragraph, no blank lines
    const result = service.chunk(
      longParagraph,
      config({ strategy: ChunkingStrategy.RECURSIVE, chunkSize: 80, chunkOverlap: 10, maxChunkSize: 100 }),
    );
    for (const chunk of result.chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100);
    }
  });

  it('semantic chunking falls back to sentence grouping and says so in notes', () => {
    const result = service.chunk('One. Two. Three.', config({ strategy: ChunkingStrategy.SEMANTIC, chunkSize: 50, chunkOverlap: 0 }));
    expect(result.notes.some((n) => n.toLowerCase().includes('heuristic'))).toBe(true);
  });

  it('merges an undersized trailing chunk into its predecessor', () => {
    const text = 'a'.repeat(105);
    const result = service.chunk(text, config({ strategy: ChunkingStrategy.FIXED_SIZE, chunkSize: 100, chunkOverlap: 0, minChunkSize: 20 }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].text.length).toBe(105);
  });
});
