import { PlatformConfigService } from './platform-config.service';

describe('PlatformConfigService', () => {
  let service: PlatformConfigService;

  beforeEach(() => {
    // No env overrides - exercises the real bundled backend/config/*.yaml files,
    // the same way the running app resolves them (paths are relative to process.cwd()).
    service = new PlatformConfigService({ get: () => undefined } as any);
    service.onModuleInit();
  });

  it('loads the platform database catalog', () => {
    expect(service.getSupportedPlatforms().length).toBeGreaterThan(0);
  });

  it('loads the AI Factory Pattern Library with all 13 patterns and required fields', () => {
    const patterns = service.getPatternCatalog();
    expect(patterns).toHaveLength(13);

    for (const pattern of patterns) {
      expect(typeof pattern.id).toBe('string');
      expect(typeof pattern.name).toBe('string');
      expect(typeof pattern.description).toBe('string');
      expect(typeof pattern.industry).toBe('string');
      expect(Array.isArray(pattern.typicalDataTypes)).toBe(true);
      expect(Array.isArray(pattern.candidateTechnologyCategories)).toBe(true);
      expect(typeof pattern.defaultAssessment).toBe('object');
    }

    const ids = patterns.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(ids).toContain('enterprise-document-rag');
    expect(ids).toContain('healthcare-rag');
    expect(ids).toContain('high-qps-enterprise-search');
  });

  it('includes a vectorless pattern that seeds no vector count and relies on full-text search', () => {
    const p = service.getPatternCatalog().find((x) => x.id === 'vectorless-document-reasoning')!;
    expect(p).toBeDefined();
    expect(p.defaultAssessment.estimatedVectorCount).toBeUndefined();
    expect(p.defaultAssessment.requiresFullTextSearch).toBe(true);
    expect(p.defaultAssessment.requiresHybridSearch).toBe(false);
    // Several navigation calls per question - left for the project to measure, not invented here
    expect(p.tokenObservabilityProfile.llmCallsPerRequest).toBeNull();
    // Seeds the Retrieval Strategy Assessment so choosing the pattern runs the "is a vector DB needed?" check
    expect(p.defaultAssessment.documentStructure).toBe('structured');
    const mix = ['queryMixExactPercent', 'queryMixMultiHopPercent', 'queryMixSemanticPercent', 'queryMixAnalyticsPercent', 'queryMixRelationshipPercent']
      .map((k) => p.defaultAssessment[k] as number);
    expect(mix.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("does not fabricate a decision - every pattern's defaultAssessment is a partial input, never a platform pick", () => {
    for (const pattern of service.getPatternCatalog()) {
      expect(pattern.defaultAssessment.platform).toBeUndefined();
    }
  });

  it('gives every pattern an honest token profile - no invented token counts or utilization (validation spec S1-S2)', () => {
    for (const pattern of service.getPatternCatalog()) {
      const p = pattern.tokenObservabilityProfile;
      expect(['rag', 'agent', 'search', 'recommendation', 'multimodal_search']).toContain(p.workloadType);
      expect(['required', 'optional', 'none']).toContain(p.llmUsage);
      expect(p.guidance.length).toBeGreaterThan(0);
      for (const k of Object.keys(p)) expect(['workloadType', 'llmUsage', 'llmRequestSharePercent', 'llmCallsPerRequest', 'agentStepsPerRequest', 'guidance']).toContain(k);
      // Search QPS is not LLM QPS: an optional LLM never gets a made-up share.
      if (p.llmUsage === 'optional') expect(p.llmRequestSharePercent).toBeNull();
      if (p.llmUsage === 'none') expect([p.llmRequestSharePercent, p.llmCallsPerRequest]).toEqual([0, 0]);
    }
    expect(service.getPatternCatalog().find((x) => x.id === 'recommendation-engine')!.tokenObservabilityProfile.llmUsage).toBe('none');
  });
});
