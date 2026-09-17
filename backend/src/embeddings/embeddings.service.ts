import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { EmbeddingProviderCatalogEntry, ResolvedEmbeddingModel } from './embedding.types';

@Injectable()
export class EmbeddingsService {
  constructor(private readonly platformConfig: PlatformConfigService) {}

  getCatalog(): EmbeddingProviderCatalogEntry[] {
    return this.platformConfig.getEmbeddingProviders() as EmbeddingProviderCatalogEntry[];
  }

  resolveModel(providerId: string, modelId: string): ResolvedEmbeddingModel {
    const provider = this.getCatalog().find((p) => p.id === providerId);
    if (!provider) {
      throw new NotFoundException(`Unknown embedding provider '${providerId}'.`);
    }
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) {
      throw new NotFoundException(`Unknown model '${modelId}' for provider '${providerId}'.`);
    }
    return { ...model, providerId: provider.id, providerLabel: provider.label };
  }

  /** Phase 2 requirement: "Validate embedding dimension against database schema." */
  validateDimension(providerId: string, modelId: string, expectedDimension: number): { valid: boolean; message?: string } {
    const model = this.resolveModel(providerId, modelId);
    if (model.dimension !== expectedDimension) {
      return {
        valid: false,
        message: `Model '${modelId}' produces ${model.dimension}-dimensional vectors, but ${expectedDimension} was expected.`,
      };
    }
    return { valid: true };
  }
}
