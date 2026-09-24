import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { PlatformConfigService } from '../common/config/platform-config.service';

const catalog = [
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'text-embedding-3-small', label: 'small', dimension: 1536, maxInputTokens: 8191, costPerMillionTokens: 0.02, languageSupport: ['en'], qualityTier: 'high', modelVersion: '3-small', status: 'active' },
      { id: 'text-embedding-ada-002', label: 'ada-002', dimension: 1536, maxInputTokens: 8191, costPerMillionTokens: 0.1, languageSupport: ['en'], qualityTier: 'medium', modelVersion: 'ada-002', status: 'retired' },
    ],
  },
];

describe('EmbeddingsService', () => {
  let service: EmbeddingsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmbeddingsService, { provide: PlatformConfigService, useValue: { getEmbeddingProviders: () => catalog } }],
    }).compile();
    service = module.get(EmbeddingsService);
  });

  it('resolves a known model', () => {
    const model = service.resolveModel('openai', 'text-embedding-3-small');
    expect(model.dimension).toBe(1536);
    expect(model.providerLabel).toBe('OpenAI');
  });

  it('throws NotFoundException for an unknown provider', () => {
    expect(() => service.resolveModel('unknown', 'x')).toThrow(NotFoundException);
  });

  it('throws NotFoundException for an unknown model on a known provider', () => {
    expect(() => service.resolveModel('openai', 'unknown-model')).toThrow(NotFoundException);
  });

  it('flags a dimension mismatch', () => {
    const result = service.validateDimension('openai', 'text-embedding-3-small', 768);
    expect(result.valid).toBe(false);
    expect(result.message).toContain('1536');
  });

  it('validates a matching dimension', () => {
    const result = service.validateDimension('openai', 'text-embedding-3-small', 1536);
    expect(result.valid).toBe(true);
  });

  it('rejects a retired model', () => {
    expect(() => service.resolveModel('openai', 'text-embedding-ada-002')).toThrow(BadRequestException);
  });
});
