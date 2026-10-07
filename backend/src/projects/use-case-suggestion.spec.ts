import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SuggestablePattern, suggestUseCase } from './use-case-suggestion';
import { CustomerMode } from './enums/customer-mode.enum';

// The real catalog, so the keywords shipped in config/patterns.yaml are what is tested.
const patterns = (yaml.load(fs.readFileSync(path.join(__dirname, '../../config/patterns.yaml'), 'utf8')) as { patterns: SuggestablePattern[] }).patterns;

describe('suggestUseCase', () => {
  it('gives every pattern suggestion keywords and a use case written for the application', () => {
    for (const p of patterns) {
      expect(p.suggestion?.keywords?.length).toBeGreaterThan(0);
      expect(p.suggestion?.useCase).toContain('{name}');
    }
  });

  it.each([
    ['Predictive Maintenance & Fault Diagnosis', 'iot-semantic-search', 'high'],
    ['IoT Telemetry Vector Search Platform', 'iot-semantic-search', 'high'],
    ['PharmaAI Factory', 'healthcare-rag', 'medium'],
    ['RAG Support Bot', 'customer-support-rag', 'medium'],
    ['HR Policy Assistant', 'enterprise-document-rag', 'high'],
    ['Claims Fraud Detection', 'financial-document-rag', 'high'],
    ['Developer Code Copilot', 'code-rag', 'high'],
    ['Incident Log Analyzer', 'log-observability-search', 'high'],
    ['Product Recommendation Service', 'recommendation-engine', 'high'],
    ['Agent Memory Store', 'agentic-ai-memory', 'high'],
    ['PageIndex Annual Report Reader', 'vectorless-document-reasoning', 'high'],
    ['Vectorless Maintenance Manual Navigator', 'vectorless-document-reasoning', 'high'],
  ])('matches "%s" to %s (%s confidence)', (name, patternId, confidence) => {
    const s = suggestUseCase(name, patterns);
    expect(s.patternId).toBe(patternId);
    expect(s.confidence).toBe(confidence);
    expect(s.industry).toBe(patterns.find((p) => p.id === patternId)!.industry);
    expect(s.businessUseCase.startsWith(`${name} `)).toBe(true);
    expect(s.businessUseCase).not.toContain('{name}');
  });

  it('does not match short keywords inside longer words', () => {
    // "log" must not match "logistics", "care" must not match "career", "code" must not match "codex".
    expect(suggestUseCase('Logistics Planner', patterns).patternId).not.toBe('log-observability-search');
    expect(suggestUseCase('Career Portal', patterns).patternId).not.toBe('healthcare-rag');
  });

  it('does not treat "AI Factory" in a name as a manufacturing plant', () => {
    expect(suggestUseCase('AutoAI Factory', patterns).patternId).toBeNull();
  });

  it('falls back to a generic use case for the requester to complete when nothing matches', () => {
    const s = suggestUseCase('  Project   Zephyr ', patterns);
    expect(s).toMatchObject({ patternId: null, patternName: null, industry: null, confidence: 'low', customerMode: null, matchedKeywords: [] });
    expect(s.businessUseCase).toMatch(/^Project Zephyr uses semantic \(vector\) search/);
    expect(s.reason).toContain('generic starting point');
  });

  it('suggests Existing / Modernization only when the name says something is being replaced', () => {
    const s = suggestUseCase('Legacy Document Search Migration', patterns);
    expect(s.customerMode).toBe(CustomerMode.EXISTING);
    expect(s.patternId).toBe('enterprise-document-rag');
    expect(s.matchedKeywords).toEqual(expect.arrayContaining(['document', 'migration', 'legacy']));
    expect(s.reason).toContain('existing deployment is being modernized');
    expect(suggestUseCase('Document Search', patterns).customerMode).toBeNull();
  });

  it('prefers the pattern with more matches, then the most specific keyword', () => {
    // "search" (hybrid) and "enterprise search" (document RAG) both match; the longer keyword wins the tie.
    expect(suggestUseCase('Enterprise Search Portal', patterns).patternId).toBe('enterprise-document-rag');
  });

  it('explains which words drove the suggestion', () => {
    expect(suggestUseCase('Patient Care Assistant', patterns).reason).toBe('"patient", "care" in the application name matches the Healthcare RAG pattern.');
  });
});
