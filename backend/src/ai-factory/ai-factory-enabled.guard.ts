import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../features/features.controller';

/**
 * Hides every AI Factory endpoint unless AI_FACTORY_ENABLED is on, using the
 * same parsing as GET /api/features so the UI and API can never disagree.
 */
@Injectable()
export class AiFactoryEnabledGuard implements CanActivate {
  private readonly features: FeaturesController;

  constructor(config: ConfigService) {
    this.features = new FeaturesController(config);
  }

  canActivate(): boolean {
    if (!this.features.flags().aiFactory) {
      throw new NotFoundException('The AI Factory workflow is not enabled on this server.');
    }
    return true;
  }
}
