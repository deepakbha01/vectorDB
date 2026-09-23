import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { embeddingEligibility, EmbeddingEligibilityRules, EmbeddingModelFacts, indexEligibility, IndexEligibilityRules, scoreEmbedding } from './eligibility.rules';

const cfg = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/ai-factory.yaml'), 'utf8')) as any;
const indexRules = cfg.indexEligibility as IndexEligibilityRules;
const embRules = cfg.embeddingEligibility as EmbeddingEligibilityRules;

describe('indexEligibility (config/ai-factory.yaml indexEligibility)', () => {
  const ctx = { availableMemoryGb: 64, recallTarget: 0.9, updateFrequency: 'low' };

  it('passes an index that fits memory, recall and update pattern', () => {
    expect(indexEligibility({ indexType: 'hnsw', estimatedMemoryGb: 20 }, ctx, indexRules)).toEqual({ eligibility: 'eligible', failures: [], conditions: [] });
  });

  it('rejects an index that needs more memory than is available', () => {
    const v = indexEligibility({ indexType: 'hnsw', estimatedMemoryGb: 80 }, ctx, indexRules);
    expect(v.eligibility).toBe('not_eligible');
    expect(v.failures[0]).toMatch(/Needs ~80.0 GB, more than the 64 GB available/);
  });

  it('is conditional when memory headroom is thin', () => {
    expect(indexEligibility({ indexType: 'hnsw', estimatedMemoryGb: 60 }, ctx, indexRules).conditions[0]).toMatch(/94% of available memory/);
  });

  it('rejects a family that cannot typically reach the recall target, and is conditional near the ceiling', () => {
    expect(indexEligibility({ indexType: 'pq', estimatedMemoryGb: 5 }, { ...ctx, recallTarget: 0.95 }, indexRules).eligibility).toBe('not_eligible');
    expect(indexEligibility({ indexType: 'pq', estimatedMemoryGb: 5 }, { ...ctx, recallTarget: 0.91 }, indexRules).eligibility).toBe('conditional');
    expect(indexEligibility({ indexType: 'hnsw', estimatedMemoryGb: 5 }, { ...ctx, recallTarget: 0.95 }, indexRules).eligibility).toBe('eligible');
  });

  it('flags update-sensitive families', () => {
    expect(indexEligibility({ indexType: 'ivf_flat', estimatedMemoryGb: 5 }, { ...ctx, updateFrequency: 'high' }, indexRules).conditions[0]).toMatch(/re-clustering/);
    expect(indexEligibility({ indexType: 'hnsw', estimatedMemoryGb: 5 }, { ...ctx, updateFrequency: 'high' }, indexRules).eligibility).toBe('eligible');
  });
});

describe('embeddingEligibility (config/ai-factory.yaml embeddingEligibility)', () => {
  const m = (o: Partial<EmbeddingModelFacts> = {}): EmbeddingModelFacts => ({
    providerId: 'openai', modelId: 'x', label: 'X', dimension: 1536, maxInputTokens: 8191, costPerMillionTokens: 0.02, languageSupport: ['en'], qualityTier: 'high', status: 'active', ...o,
  });
  const ctx = { chunkTokens: 300, selfHostingRequired: false, multilingual: false };

  it.each([
    ['retired model', m({ status: 'retired' }), ctx, /retired/],
    ['chunks longer than the input limit', m({ maxInputTokens: 256 }), ctx, /would be truncated/],
    ['third-party API when self-hosting is required', m(), { ...ctx, selfHostingRequired: true }, /inside the customer boundary/],
    ['English-only when multilingual is required', m(), { ...ctx, multilingual: true }, /English-only/],
  ])('not eligible: %s', (_n, model, c, message) => {
    const v = embeddingEligibility(model, c, embRules);
    expect(v.eligibility).toBe('not_eligible');
    expect(v.failures.join(' ')).toMatch(message);
  });

  it('allows self-hosted open-source models inside the boundary', () => {
    expect(embeddingEligibility(m({ providerId: 'open_source', costPerMillionTokens: 0 }), { ...ctx, selfHostingRequired: true }, embRules).eligibility).toBe('eligible');
  });

  it('is conditional for deprecated or partially multilingual models', () => {
    expect(embeddingEligibility(m({ status: 'deprecated' }), ctx, embRules).eligibility).toBe('conditional');
    expect(embeddingEligibility(m({ languageSupport: ['en', 'multilingual-partial'] }), { ...ctx, multilingual: true }, embRules).eligibility).toBe('conditional');
  });

  it('scores quality, relative cost and dimension efficiency', () => {
    const cheapSmall = m({ modelId: 'a', dimension: 768, costPerMillionTokens: 0, qualityTier: 'high' });
    const pricyBig = m({ modelId: 'b', dimension: 3072, costPerMillionTokens: 0.13, qualityTier: 'highest' });
    const all = [cheapSmall, pricyBig];
    expect(scoreEmbedding(cheapSmall, all, embRules)).toBeCloseTo(0.8 * 0.5 + 1 * 0.3 + 1 * 0.2, 3);
    expect(scoreEmbedding(pricyBig, all, embRules)).toBeCloseTo(1 * 0.5 + 0 * 0.3 + 0.25 * 0.2, 3);
  });
});
