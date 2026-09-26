import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../../features/features.controller';

/**
 * Hides every Token Observability endpoint unless both AI_FACTORY_ENABLED and
 * TOKEN_OBSERVABILITY_ENABLED are on, parsed exactly as GET /api/features does.
 */
@Injectable()
export class TokenObservabilityEnabledGuard implements CanActivate {
  private readonly features: FeaturesController;

  constructor(config: ConfigService) {
    this.features = new FeaturesController(config);
  }

  canActivate(): boolean {
    if (!this.features.flags().tokenObservability) {
      throw new NotFoundException('Token Observability is not enabled on this server.');
    }
    return true;
  }
}
