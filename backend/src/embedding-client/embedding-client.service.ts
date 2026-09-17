import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { EmbeddingRequest, EmbeddingResult } from './embedding-client.types';

/**
 * Turns text into a vector for the Phase 5 ingestion pipeline.
 *
 * Only OpenAI is wired to a real API today (via OPENAI_API_KEY - never
 * hard-coded, read from the environment at call time). Every other provider
 * in the Phase 2 catalog (Cohere, Google, open-source/self-hosted) falls back
 * to a deterministic offline stand-in: a SHA-256-seeded pseudo-random unit
 * vector of the correct dimension. This is NOT a real embedding - it carries
 * no semantic meaning and must never be used to judge real search quality -
 * but it lets the full pipeline (chunk -> embed -> validate -> store -> index
 * -> search) run end-to-end deterministically without network access or paid
 * API calls, which matters for local development, CI, and this project's own
 * benchmark harness (Sprint 7). Adding a real client for another provider is
 * an isolated change: implement one branch in `callLiveProvider`.
 */
@Injectable()
export class EmbeddingClientService {
  private readonly logger = new Logger(EmbeddingClientService.name);

  constructor(private readonly config: ConfigService) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.providerId === 'openai' && this.config.get<string>('OPENAI_API_KEY')) {
      try {
        return await this.callOpenAi(request);
      } catch (error) {
        this.logger.warn(`OpenAI embedding call failed, falling back to offline stand-in: ${(error as Error).message}`);
      }
    }
    return { vector: this.offlineEmbedding(request.text, request.dimension), isLiveProvider: false };
  }

  private async callOpenAi(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.get<string>('OPENAI_API_KEY')}`,
      },
      body: JSON.stringify({ model: request.modelId, input: request.text }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings API returned ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return { vector: body.data[0].embedding, isLiveProvider: true };
  }

  /** Deterministic, dependency-free pseudo-embedding: same text always yields the same vector. */
  private offlineEmbedding(text: string, dimension: number): number[] {
    const seedBytes = createHash('sha256').update(text).digest();
    let state = seedBytes.readUInt32LE(0) || 1;
    const nextRandom = () => {
      // mulberry32 PRNG - fast, deterministic, good-enough distribution for a stand-in vector.
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const vector = Array.from({ length: dimension }, () => nextRandom() * 2 - 1);
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / magnitude);
  }
}
