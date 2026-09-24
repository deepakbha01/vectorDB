import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigService } from '@nestjs/config';
import { AiFactoryConfigService } from './ai-factory-config.service';
import { analyseImpact, sameValue } from './impact.engine';

// Uses the real dependency graph and impact map so the tests describe actual behaviour.
const cfg = new AiFactoryConfigService({} as ConfigService);
cfg.setConfig(yaml.load(fs.readFileSync(path.join(__dirname, '../../config/ai-factory.yaml'), 'utf8')) as Record<string, any>);

const base = { qps: 20, peakQps: 40, hasGpu: false, environment: 'production', documentGrowthPercentPerMonth: 5, existingPlatforms: ['qdrant', 'redis'], containsPii: false, dataResidencyRequirement: null };
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
    expect(r.changes).toEqual([{ field: 'qps', from: 20, to: 200, directPhases: ['data_embeddings', 'vector_db_selection', 'inference', 'workload_profile', 'finops'] }]);
    expect(affected(r)).toEqual({
      data_embeddings: 'rerun',
      index_design: 'rerun',
      vector_db_selection: 'rerun',
      infrastructure: 'rerun',
      infrastructure_design: 'rerun',
      rag_agent_architecture: 'rerun',
      security_governance: 'rerun',
      performance_benchmark: 'rerun',
      finops: 'rerun',
      operations_model: 'rerun',
      optimization: 'rerun',
      capacity: 'rerun',
      inference: 'review',
      workload_profile: 'review',
    });
    const idx = r.affected.find((a) => a.phase === 'index_design')!;
    expect(idx.because).toEqual(['built from Data & Embedding design, which must be re-run']);
  });

  it('does not recalculate unrelated phases (spec §22): a growth-rate change re-runs capacity, what is built on it and cost, and only asks the profile for review', () => {
    const r = run({ documentGrowthPercentPerMonth: 12 });
    expect(affected(r)).toEqual({ capacity: 'rerun', operations_model: 'rerun', finops: 'rerun', workload_profile: 'review' });
    expect(r.affected.find((a) => a.phase === 'operations_model')!.because).toEqual(['built from Capacity plan, which must be re-run']);
    expect(r.unaffected.map((u) => u.phase)).toEqual(expect.arrayContaining(['data_embeddings', 'index_design', 'vector_db_selection', 'infrastructure', 'optimization', 'inference']));
  });

  it('lists answers no engine reads as no-impact instead of triggering re-runs', () => {
    const r = run({ environment: 'staging' });
    expect(r.noImpactFields).toEqual(['environment']);
    expect(r.affected).toEqual([]);
  });

  it('sends GPU availability to the Workload Profile for review and re-runs the designs that read it, and what is built from them (Waves 2, 5-10)', () => {
    const r = run({ hasGpu: true });
    expect(r.noImpactFields).toEqual([]);
    expect(affected(r)).toEqual({ workload_profile: 'review', infrastructure_design: 'rerun', rag_agent_architecture: 'rerun', security_governance: 'rerun', performance_benchmark: 'rerun', finops: 'rerun', operations_model: 'rerun' });
    expect(r.affected.find((a) => a.phase === 'security_governance')!.because[0]).toMatch(/built from/);
  });

  it('re-runs the security assessment when a security requirement changes, and nothing else it does not feed', () => {
    const r = run({ requiresAuditLogging: true });
    expect(affected(r)).toMatchObject({ security_governance: 'rerun' });
    expect(r.affected.find((a) => a.phase === 'security_governance')!.because).toContain('reads requiresAuditLogging directly');
  });

  it('treats compliance changes as affecting selection and inference', () => {
    const r = run({ containsPii: true, dataResidencyRequirement: 'EU' });
    expect(affected(r)).toMatchObject({ vector_db_selection: 'rerun', inference: 'review', infrastructure_design: 'rerun', rag_agent_architecture: 'rerun' });
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
