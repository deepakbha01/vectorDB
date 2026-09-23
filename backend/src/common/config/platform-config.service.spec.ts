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

  it('loads the AI Factory Pattern Library with all 12 patterns and required fields', () => {
    const patterns = service.getPatternCatalog();
    expect(patterns).toHaveLength(12);

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

  it("does not fabricate a decision - every pattern's defaultAssessment is a partial input, never a platform pick", () => {
    for (const pattern of service.getPatternCatalog()) {
      expect(pattern.defaultAssessment.platform).toBeUndefined();
    }
  });
});
