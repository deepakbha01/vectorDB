import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { checkEligibility, effectiveWeights, selectModels } from './model-selection.engine';
import { resolveModelRequirements } from './model-selection.service';
import { ModelCatalogue, ModelRequirements } from './model-selection.types';

// The real catalogue, so these tests describe shipped behaviour.
const cat = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/models.yaml'), 'utf8')) as ModelCatalogue;
const inference = yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/inference.yaml'), 'utf8')) as any;
const model = (id: string) => cat.models.find((m) => m.id === id)!;

const req = (o: Partial<ModelRequirements> = {}): ModelRequirements => ({
  requiredContextTokens: 8192,
  reasoningComplexity: 'medium',
  accuracyRequirement: 'standard',
  multilingual: false,
  multimodal: false,
  toolCalling: false,
  structuredOutput: false,
  codeGeneration: false,
  fineTuning: 'none',
  selfHostingRequired: false,
  permissiveLicenceOnly: false,
  restrictedData: false,
  latencyPriority: 'medium',
  costPriority: 'medium',
  ...o,
});

describe('model catalogue (config/models.yaml)', () => {
  it('links every model to the inference catalogue and a known licence, with tiers in 1-5', () => {
    const infIds = new Set(inference.models.map((m: any) => m.id));
    const tiers = new Set(inference.managedApiTiers.map((t: any) => t.id));
    for (const m of cat.models) {
      expect(m.inferenceModelId ? infIds.has(m.inferenceModelId) : tiers.has(m.managedApiTierId)).toBe(true);
      expect(cat.licences[m.licence]).toBeDefined();
      for (const t of [m.qualityTier, m.reasoningTier, m.latencyTier, m.costTier]) expect(t >= 1 && t <= 5).toBe(true);
    }
    expect(Object.values(cat.scoringWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('is technology-neutral: proprietary models are vendor-neutral tiers, not named products', () => {
    for (const m of cat.models.filter((x) => x.family === 'proprietary_api')) expect(m.label).toMatch(/^Managed API - /);
  });
});

describe('checkEligibility - mandatory rules make a model NOT ELIGIBLE regardless of score', () => {
  it.each([
    ['context window', 'qwen2.5-72b', { requiredContextTokens: 100_000 }, /Context window 32,768/],
    ['multimodal', 'llama-3.3-70b', { multimodal: true }, /image \/ multimodal/],
    ['tool calling', 'mixtral-8x7b', { toolCalling: true }, /tool \/ function calling/],
    ['self-hosting', 'api-frontier', { selfHostingRequired: true }, /third-party API/],
    ['fine-tuning', 'api-mid', { fineTuning: 'adapter' }, /Cannot be fine-tuned/],
    ['permissive licence', 'llama-3.3-70b', { permissiveLicenceOnly: true }, /not permissive/],
    ['GPU capacity', 'llama-3.3-70b', { maxSelfHostedParamsB: 30 }, /70.6B parameters exceeds/],
  ])('%s', (_name, id, o, message) => {
    const v = checkEligibility(model(id as string), req(o as Partial<ModelRequirements>), cat);
    expect(v.eligibility).toBe('not_eligible');
    expect(v.failures.join(' ')).toMatch(message as RegExp);
  });

  it.each([
    ['restricted data on an API needs a BAA/DPA', 'api-mid', { restrictedData: true }, /BAA \/ DPA/],
    ['critical accuracy on a low quality tier', 'llama-3.1-8b', { accuracyRequirement: 'critical' }, /quality tier 2 is below the 4/],
    ['high reasoning on a low reasoning tier', 'qwen2.5-7b', { reasoningComplexity: 'high' }, /Reasoning tier 2 is below the 3/],
  ])('conditional: %s', (_name, id, o, message) => {
    const v = checkEligibility(model(id as string), req(o as Partial<ModelRequirements>), cat);
    expect(v.eligibility).toBe('conditional');
    expect(v.conditions.join(' ')).toMatch(message as RegExp);
  });

  it('notes non-permissive licence terms without excluding the model', () => {
    // Low reasoning so the only thing under test is the licence (tier-1 reasoning is conditional at the medium default).
    const v = checkEligibility(model('llama-3.1-8b'), req({ reasoningComplexity: 'low' }), cat);
    expect(v.eligibility).toBe('eligible');
    expect(v.notes[0]).toMatch(/Llama Community License/);
  });
});

describe('selectModels', () => {
  it('never ranks a not-eligible model above an eligible one, and never offers it as secondary/fallback', () => {
    const r = selectModels(req({ selfHostingRequired: true }), cat);
    const apis = r.candidates.filter((c) => c.family === 'proprietary_api');
    expect(apis.every((c) => c.eligibility === 'not_eligible')).toBe(true);
    const lastUsableIndex = r.candidates.map((c) => c.eligibility !== 'not_eligible').lastIndexOf(true);
    expect(r.candidates.slice(0, lastUsableIndex + 1).every((c) => c.eligibility !== 'not_eligible')).toBe(true);
    for (const pick of [r.primary, r.secondary, r.fallback]) expect(pick?.family).toBe('open_weight');
    expect(r.wouldChangeIf).toContain('Allowing a third-party API would add the managed API tiers as candidates.');
  });

  it('picks a secondary from the other deployment family when one is usable (portability)', () => {
    const r = selectModels(req(), cat);
    expect(r.primary).not.toBeNull();
    expect(r.secondary!.family).not.toBe(r.primary!.family);
    expect(r.roles.secondary).toMatch(/Alternative deployment family/);
  });

  it('chooses the fastest / cheapest remaining usable model as fallback', () => {
    const r = selectModels(req(), cat);
    const remaining = r.candidates.filter((c) => c.eligibility !== 'not_eligible' && c.id !== r.primary!.id && c.id !== r.secondary!.id);
    const best = Math.max(...remaining.map((c) => c.criteria.latency + c.criteria.cost));
    expect(r.fallback!.criteria.latency + r.fallback!.criteria.cost).toBe(best);
  });

  it('prefers stronger models when accuracy is critical and cheaper ones when cost is the priority', () => {
    const critical = selectModels(req({ accuracyRequirement: 'critical', reasoningComplexity: 'high' }), cat);
    const cheap = selectModels(req({ costPriority: 'high', latencyPriority: 'high' }), cat);
    expect(model(critical.primary!.id).qualityTier).toBeGreaterThanOrEqual(4);
    expect(model(cheap.primary!.id).costTier).toBeGreaterThanOrEqual(4);
  });

  it('keeps restricted-data API candidates only as conditional, so an eligible self-hostable model wins', () => {
    const r = selectModels(req({ restrictedData: true, accuracyRequirement: 'high' }), cat);
    expect(r.primary!.family).toBe('open_weight');
    expect(r.candidates.filter((c) => c.family === 'proprietary_api').every((c) => c.eligibility === 'conditional')).toBe(true);
  });

  it('never claims "highest score" when a conditional model out-scores the eligible primary (spec §24)', () => {
    // Regulated agent workload: API tiers score higher but are conditional (PHI needs a BAA/DPA).
    const r = selectModels(req({ restrictedData: true, accuracyRequirement: 'critical', reasoningComplexity: 'high', latencyPriority: 'high', toolCalling: true, structuredOutput: true }), cat);
    const higher = r.candidates.filter((c) => c.eligibility === 'conditional' && c.score > r.primary!.score);
    expect(r.primary!.eligibility).toBe('eligible');
    expect(higher.length).toBeGreaterThan(0);
    expect(r.why[0]).toMatch(/highest-scoring model that meets every requirement without conditions/);
    expect(r.why[1]).toMatch(/scores higher .* but only with conditions: Restricted data/);
    expect(r.wouldChangeIf.some((w) => w.includes('would be preferred') && w.includes('if its conditions are accepted'))).toBe(true);
  });

  it('reports an exact tie and breaks it by a stated rule (context window), never by catalogue order', () => {
    // On-premises critical agent workload: Llama 3.3 70B and Qwen2.5 72B have identical tiers → identical scores.
    const r = selectModels(req({ selfHostingRequired: true, accuracyRequirement: 'critical', reasoningComplexity: 'high', latencyPriority: 'high', toolCalling: true, structuredOutput: true }), cat);
    expect(r.candidates[0].score).toBe(r.candidates[1].score);
    expect(r.primary!.id).toBe('llama-3.3-70b'); // 131,072-token context beats 32,768
    expect(r.why[0]).toMatch(/Llama 3.3 70B Instruct and Qwen2.5 72B Instruct are tied at/);
    expect(r.why[1]).toMatch(/Tie broken by the larger context window \(131,072 vs 32,768 tokens\)/);
    expect(r.confidence).toBe('medium');
    const reversed = selectModels(req({ selfHostingRequired: true, accuracyRequirement: 'critical', reasoningComplexity: 'high', latencyPriority: 'high', toolCalling: true, structuredOutput: true }), { ...cat, models: [...cat.models].reverse() });
    expect(reversed.primary!.id).toBe('llama-3.3-70b');
  });

  it('explains when nothing is eligible, with low confidence and what to relax', () => {
    const r = selectModels(req({ multimodal: true, selfHostingRequired: true }), cat);
    expect(r).toMatchObject({ primary: null, secondary: null, fallback: null, confidence: 'low' });
    expect(r.why[0]).toMatch(/No model in the catalogue meets every mandatory requirement/);
  });

  it('reports a conditional primary with medium confidence and lists its conditions to validate', () => {
    // Only two small models: with critical accuracy both fall below the quality tier (conditional), none is excluded.
    const small = { ...cat, models: cat.models.filter((m) => m.id === 'llama-3.1-8b' || m.id === 'qwen2.5-7b') };
    const r = selectModels(req({ accuracyRequirement: 'critical' }), small);
    expect(r.candidates.every((c) => c.eligibility === 'conditional')).toBe(true);
    expect(r.primary!.eligibility).toBe('conditional');
    expect(r.confidence).toBe('medium');
    expect(r.why.some((w) => w.startsWith('Recommended with conditions'))).toBe(true);
    expect(r.benchmarkRequired.some((b) => b.startsWith('Validate:'))).toBe(true);
  });

  it('shows higher-scoring models that were excluded, and why', () => {
    const r = selectModels(req({ requiredContextTokens: 100_000, selfHostingRequired: true }), cat);
    expect(r.primary!.id).toMatch(/llama/);
    for (const c of r.candidates.filter((x) => x.eligibility === 'not_eligible' && x.score > r.primary!.score)) {
      expect(r.wouldChangeIf.some((w) => w.startsWith(c.label))).toBe(true);
    }
  });

  it('renormalises weights after priority multipliers', () => {
    const w = effectiveWeights(req({ latencyPriority: 'high', costPriority: 'high' }), cat);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    expect(w.latency).toBeGreaterThan(cat.scoringWeights.latency);
  });
});

describe('resolveModelRequirements - defaults from the Workload Profile, with the reason', () => {
  const profile = (o: Record<string, any> = {}): any => ({
    version: 2,
    inputs: {
      workloadTypes: { value: ['rag', 'agentic', 'classification'] },
      deploymentTargets: { value: ['on_premises'] },
      businessCriticality: { value: 'mission_critical' },
      targetTtftMs: { value: 700 },
      businessDomain: { value: 'Healthcare' },
      ...o,
    },
    result: { architecture: { components: ['rag', 'agent'], label: 'Hybrid' }, dataClassification: { multimodal: false, level: 'restricted' } },
  });

  it('derives requirements from the profile and records why', () => {
    const { requirements: r, sources: s } = resolveModelRequirements({}, profile());
    expect(r).toMatchObject({ reasoningComplexity: 'high', accuracyRequirement: 'critical', toolCalling: true, structuredOutput: true, selfHostingRequired: true, restrictedData: true, latencyPriority: 'high', domain: 'Healthcare' });
    expect(s.toolCalling).toEqual({ source: 'workload_profile', detail: 'Workload Profile v2: architecture Hybrid' });
    expect(s.selfHostingRequired.detail).toMatch(/on-premises-only deployment/);
    expect(s.requiredContextTokens).toEqual({ source: 'default', detail: 'default 8,192 tokens - set it from the longest prompt + output' });
  });

  it('lets the user override any derived requirement', () => {
    const { requirements: r, sources: s } = resolveModelRequirements({ selfHostingRequired: false, accuracyRequirement: 'standard' }, profile());
    expect(r.selfHostingRequired).toBe(false);
    expect(s.selfHostingRequired.source).toBe('user');
    expect(r.accuracyRequirement).toBe('standard');
  });

  it('falls back to stated defaults without a profile', () => {
    const { requirements: r, sources: s } = resolveModelRequirements({}, null);
    expect(r).toMatchObject({ reasoningComplexity: 'medium', accuracyRequirement: 'standard', selfHostingRequired: false, restrictedData: false });
    expect(Object.values(s).every((x) => x.source === 'default')).toBe(true);
  });

  it('feeds straight into selection: on-premises restricted agent workload → self-hostable model with tool calling', () => {
    const { requirements } = resolveModelRequirements({}, profile());
    const r = selectModels(requirements, cat);
    expect(r.primary!.family).toBe('open_weight');
    expect(model(r.primary!.id).capabilities).toContain('tool_calling');
  });
});
