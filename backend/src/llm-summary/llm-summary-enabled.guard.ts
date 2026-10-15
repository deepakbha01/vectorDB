import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../features/features.controller';

/** Hides the LLM summary endpoint unless LLM_SUMMARY_ENABLED is on and an LLM is configured, matching GET /api/features. */
@Injectable()
export class LlmSummaryEnabledGuard implements CanActivate {
  private readonly features: FeaturesController;

  constructor(config: ConfigService) {
    this.features = new FeaturesController(config);
  }

  canActivate(): boolean {
    if (!this.features.flags().llmSummary) {
      throw new NotFoundException('LLM summaries are not enabled on this server.');
    }
    return true;
  }
}
