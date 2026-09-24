import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigService } from '@nestjs/config';
import { AiFactoryConfigService } from './ai-factory-config.service';
import { analyseImpact, sameValue } from './impact.engine';

// Uses the real dependency graph and impact map so the tests describe actual behaviour.
const cfg = new AiFactoryConfigService({} as ConfigService);
cfg.setConfig(yaml.load(fs.readFileSync(path.join(__dirname, '../../config/ai-factory.yaml'), 'utf8')) as Record<string, any>);

const base = { qps: 20, peakQps: 40, hasGpu: false, documentGrowthPercentPerMonth: 5, existingPlatforms: ['qdrant', 'redis'], containsPii: false, dataResidencyRequirement: null };
const run = (changes: Record<string, unknown>) =>
  analyseImpact(cfg.getPhases(), cfg.getParameterImpact(), { version: 1, values: base }, { version: 2, values: { ...base, ...changes } });
const affected = (r: ReturnType<typeof run>) => Object.fromEntries(r.affected.map((a) => [a.phase, a.action]));

describe('analyseImpact', () => {
  it('reports nothing when no answer changed', () => {
    const r = run({});
    expect(r.changes).toEqual([]);
    expect(r.affected).toEqual([]);
    expect(r.unaffected.every((u) => u.reason === 'No Discovery answers changed.')).toBe(true);
  });

  it('re-runs direct readers and everything built from them; advisory readers only need review', () => {
    const r = run({ qps: 200 });
    expect(r.changes).toEqual([{ field: 'qps', from: 20, to: 200, directPhases: ['data_embeddings', 'vector_db_selection', 'inference'] }]);
    expect(affected(r)).toEqual({
      data_embeddings: 'rerun',
      index_design: 'rerun',
      vector_db_selection: 'rerun',
      infrastructure: 'rerun',
      optimization: 'rerun',
      capacity: 'rerun',
      inference: 'review',
    });
    const idx = r.affected.find((a) => a.phase === 'index_design')!;
    expect(idx.because).toEqual(['built from Data & Embedding design, which must be re-run']);
  });

  it('does not recalculate unrelated phases (spec §22): a growth-rate change only touches capacity', () => {
    const r = run({ documentGrowthPercentPerMonth: 12 });
    expect(affected(r)).toEqual({ capacity: 'rerun' });
    expect(r.unaffected.map((u) => u.phase)).toEqual(expect.arrayContaining(['data_embeddings', 'index_design', 'vector_db_selection', 'infrastructure', 'optimization', 'inference']));
  });

  it('lists answers no engine reads as no-impact instead of triggering re-runs', () => {
    const r = run({ hasGpu: true });
    expect(r.noImpactFields).toEqual(['hasGpu']);
    expect(r.affected).toEqual([]);
  });

  it('treats compliance changes as affecting selection and inference', () => {
    const r = run({ containsPii: true, dataResidencyRequirement: 'EU' });
    expect(affected(r)).toMatchObject({ vector_db_selection: 'rerun', inference: 'review' });
    expect(affected(r).data_embeddings).toBeUndefined();
  });
});

describe('sameValue', () => {
  it('treats empty values as equal and arrays as sets', () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue('', null)).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameValue(['a'], ['a', 'b'])).toBe(false);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(false, null)).toBe(false);
  });
});
