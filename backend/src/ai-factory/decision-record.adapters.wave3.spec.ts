import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { fromDataPipelineDesign, fromIndexDesign, fromModelSelection } from './decision-record.adapters';

// Wave 3: eligibility layers for index / embedding choices, and the model decision record.
const cfg = yaml.load(fs.readFileSync(path.join(__dirname, '../../config/ai-factory.yaml'), 'utf8')) as any;
const created = new Date('2026-09-01T10:00:00Z');

describe('fromIndexDesign with the Wave 3 eligibility layer', () => {
  const design = (o: Record<string, any> = {}): any => ({
    id: 'idx-9', version: 3, createdAt: created, decision: 'hnsw', label: 'HNSW', rationale: 'Highest recall.',
    options: [
      { indexType: 'hnsw', label: 'HNSW', totalScore: 0.9, estimatedMemoryGb: 40, evidence: [] },
      { indexType: 'ivf_flat', label: 'IVF-Flat', totalScore: 0.8, estimatedMemoryGb: 20, evidence: [] },
      { indexType: 'pq', label: 'PQ', totalScore: 0.6, estimatedMemoryGb: 4, evidence: [] },
    ],
    alternatives: [{ indexType: 'ivf_flat', reason: 'Less memory' }, { indexType: 'pq', reason: 'Least memory' }],
    configuration: [], impact: { recallEstimate: '~0.95', latencyEstimate: '<20 ms', memoryEstimateGb: 40 }, scalingConsiderations: [],
    updateFrequency: 'low', inputsUsed: { availableMemoryGb: 64, recallTarget: 0.95 }, ...o,
  });

  it('keeps the chosen index, applies eligibility to every option, and never offers a not-eligible alternative', () => {
    const r = fromIndexDesign(design(), null, cfg.indexEligibility);
    expect(r.recommendation?.id).toBe('hnsw');
    expect(Object.fromEntries(r.candidates.map((c) => [c.id, c.eligibility]))).toEqual({ hnsw: 'eligible', ivf_flat: 'eligible', pq: 'not_eligible' });
    expect(r.alternatives.map((a) => a.id)).toEqual(['ivf_flat']);
    expect(r).toMatchObject({ status: 'decided', confidence: 'high', gaps: [] });
  });

  it('treats a recall target just inside the near-ceiling margin as conditional (0.95 is the boundary for IVF-Flat)', () => {
    const r = fromIndexDesign(design({ inputsUsed: { availableMemoryGb: 64, recallTarget: 0.955 } }), null, cfg.indexEligibility);
    expect(r.candidates.find((c) => c.id === 'ivf_flat')?.eligibility).toBe('conditional');
  });

  it('flags a conflict (not a silent swap) when the chosen index fails a mandatory rule', () => {
    const r = fromIndexDesign(design({ inputsUsed: { availableMemoryGb: 32, recallTarget: 0.95 } }), null, cfg.indexEligibility);
    expect(r.recommendation?.id).toBe('hnsw');
    expect(r).toMatchObject({ status: 'conditional', confidence: 'low' });
    expect(r.gaps[0]).toMatch(/Index Design chose HNSW, which fails a mandatory rule: Needs ~40.0 GB.*IVF-Flat is the best option that passes/);
  });

  it('keeps the Wave 1 behaviour when no rules are supplied', () => {
    const r = fromIndexDesign(design(), null);
    expect(r.candidates.every((c) => c.eligibility === 'not_assessed')).toBe(true);
    expect(r.confidence).toBe('not_assessed');
  });
});

describe('fromDataPipelineDesign (embedding eligibility)', () => {
  const catalogue = [
    { providerId: 'openai', modelId: 'small', label: 'OpenAI small', dimension: 1536, maxInputTokens: 8191, costPerMillionTokens: 0.02, languageSupport: ['en', 'multilingual-partial'], qualityTier: 'high', status: 'active' },
    { providerId: 'openai', modelId: 'large', label: 'OpenAI large', dimension: 3072, maxInputTokens: 8191, costPerMillionTokens: 0.13, languageSupport: ['en', 'multilingual-partial'], qualityTier: 'highest', status: 'active' },
    { providerId: 'open_source', modelId: 'bge', label: 'BGE large', dimension: 1024, maxInputTokens: 512, costPerMillionTokens: 0, languageSupport: ['en'], qualityTier: 'high', status: 'active' },
    { providerId: 'open_source', modelId: 'e5', label: 'E5 multilingual', dimension: 1024, maxInputTokens: 512, costPerMillionTokens: 0, languageSupport: ['multilingual'], qualityTier: 'high', status: 'active' },
  ];
  const pipeline: any = { id: 'p-1', version: 2, createdAt: created, embeddingProviderId: 'openai', embeddingModelId: 'small', chunkingStrategy: 'recursive', chunkSize: 1200 };
  const ctx = (o: Record<string, any> = {}) => ({ chunkTokens: 300, selfHostingRequired: false, multilingual: false, basis: ['Self-hosting required: no (test)'], ...o });

  it('keeps the chosen model, scores every catalogue model and labels vendor figures', () => {
    const r = fromDataPipelineDesign(pipeline, catalogue, ctx(), cfg.embeddingEligibility);
    expect(r.recommendation).toEqual({ id: 'openai/small', label: 'OpenAI small' });
    expect(r.candidates).toHaveLength(4);
    expect(r.status).toBe('decided');
    expect(r.evidence.find((e) => e.label === 'Max input tokens')).toEqual({ label: 'Max input tokens', value: '8,191', evidenceType: 'vendor_listed' });
    expect(r.assumptions).toEqual([{ statement: 'Self-hosting required: no (test)', evidenceType: 'assumption' }]);
  });

  it('flags the chosen model when self-hosting is required, pointing at the best model that passes', () => {
    const r = fromDataPipelineDesign(pipeline, catalogue, ctx({ selfHostingRequired: true }), cfg.embeddingEligibility);
    expect(r).toMatchObject({ status: 'conditional', confidence: 'low' });
    expect(r.gaps[0]).toMatch(/fails a mandatory rule: Hosted by a third-party API.*is the best model that passes/);
    expect(r.alternatives.every((a) => a.id.startsWith('open_source/'))).toBe(true);
  });

  it('excludes models whose input limit would truncate the chunks', () => {
    const r = fromDataPipelineDesign(pipeline, catalogue, ctx({ chunkTokens: 900 }), cfg.embeddingEligibility);
    expect(r.candidates.filter((c) => c.eligibility === 'not_eligible').map((c) => c.id).sort()).toEqual(['open_source/bge', 'open_source/e5']);
  });

  it('says when the chosen model is not in the catalogue', () => {
    const r = fromDataPipelineDesign({ ...pipeline, embeddingModelId: 'gone' }, catalogue, ctx(), cfg.embeddingEligibility);
    expect(r.gaps[0]).toMatch(/not in the embedding catalogue/);
  });
});

describe('fromModelSelection', () => {
  const ev = (id: string, family: string, eligibility = 'eligible') => ({ id, label: id, family, eligibility, failures: [] as string[], conditions: [] as string[], notes: [] as string[], score: 0.7, criteria: {} });
  const ms: any = {
    id: 'ms-1', version: 2, createdAt: created,
    requirements: { selfHostingRequired: true, requiredContextTokens: 8192 },
    sources: { selfHostingRequired: { source: 'workload_profile', detail: 'Workload Profile v2: on-premises-only deployment' } },
    result: {
      primary: ev('llama-3.3-70b', 'open_weight'), secondary: ev('qwen2.5-72b', 'open_weight'), fallback: ev('llama-3.1-8b', 'open_weight'),
      roles: { secondary: 'Runner-up', fallback: 'Fastest / cheapest usable model' },
      confidence: 'high', candidates: [ev('llama-3.3-70b', 'open_weight'), { ...ev('api-mid', 'proprietary_api', 'not_eligible'), failures: ['third-party API'] }],
      why: ['Highest score'], tradeoffs: [], wouldChangeIf: ['x'], benchmarkRequired: ['eval'], weightsUsed: { quality: 0.3 },
    },
  };

  it('maps primary, secondary and fallback into the standard record with their roles', () => {
    const r = fromModelSelection(ms);
    expect(r).toMatchObject({ phase: 'model_selection', status: 'decided', confidence: 'high', recommendation: { id: 'llama-3.3-70b' } });
    expect(r.alternatives.map((a) => a.label)).toEqual(['Secondary: qwen2.5-72b', 'Fallback: llama-3.1-8b']);
    expect(r.candidates.find((c) => c.id === 'api-mid')).toMatchObject({ eligibility: 'not_eligible', notes: ['third-party API'] });
    expect(r.assumptions[0].statement).toBe('selfHostingRequired: true (Workload Profile v2: on-premises-only deployment)');
  });

  it('reports not feasible when nothing is eligible', () => {
    const r = fromModelSelection({ ...ms, result: { ...ms.result, primary: null, secondary: null, fallback: null, confidence: 'low' } });
    expect(r).toMatchObject({ status: 'not_feasible', recommendation: null, alternatives: [] });
  });
});
