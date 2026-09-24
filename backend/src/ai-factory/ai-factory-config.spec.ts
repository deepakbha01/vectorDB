import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigService } from '@nestjs/config';
import { AiFactoryConfigService } from './ai-factory-config.service';
import { topologicalOrder } from './lineage.engine';

// Validates the REAL config/ai-factory.yaml, so a broken graph or an unmapped
// Discovery field fails the build rather than silently mis-reporting impact.
const cfg = new AiFactoryConfigService({} as ConfigService);
cfg.setConfig(yaml.load(fs.readFileSync(path.join(__dirname, '../../config/ai-factory.yaml'), 'utf8')) as Record<string, any>);

/** Every property declared on the Discovery intake DTO (the answers a user can change). */
function discoveryFields(): string[] {
  const src = fs.readFileSync(path.join(__dirname, '../discovery/dto/create-discovery-assessment.dto.ts'), 'utf8');
  return [...src.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)[?!]?:/gm)].map((m) => m[1]);
}

describe('config/ai-factory.yaml', () => {
  const phases = cfg.getPhases();
  const keys = new Set(phases.map((p) => p.key));

  it('has an acyclic dependency graph that only references known phases', () => {
    expect(() => topologicalOrder(phases)).not.toThrow();
    for (const p of phases) for (const d of p.dependsOn) expect(keys).toContain(d.phase);
  });

  it('maps EVERY Discovery answer (new fields must be classified before they ship)', () => {
    const fields = discoveryFields();
    expect(fields.length).toBeGreaterThan(40);
    const mapped = Object.keys(cfg.getParameterImpact());
    expect(fields.filter((f) => !mapped.includes(f))).toEqual([]);
    expect(mapped.filter((f) => !fields.includes(f))).toEqual([]);
  });

  it('only routes Discovery answers to phases that read Discovery directly', () => {
    const readers = new Set(phases.filter((p) => p.dependsOn.some((d) => d.phase === 'discovery')).map((p) => p.key));
    for (const [field, targets] of Object.entries(cfg.getParameterImpact())) {
      for (const t of targets) expect({ field, target: t, readsDiscovery: readers.has(t) }).toEqual({ field, target: t, readsDiscovery: true });
    }
  });

  it('defines the 13 guided steps in order, each backed only by known phases', () => {
    const steps = cfg.getSteps();
    expect(steps.map((s) => s.number)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    for (const s of steps) for (const p of s.phases) expect(keys).toContain(p);
    for (const s of steps.filter((x) => x.coverage !== 'full')) expect(s.plannedWave).toBeGreaterThan(1);
  });
});
