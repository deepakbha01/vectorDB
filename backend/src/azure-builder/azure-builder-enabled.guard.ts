import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../features/features.controller';

/** Hides every Azure Builder endpoint unless AZURE_BUILDER_ENABLED is on, parsed exactly as GET /api/features does. */
@Injectable()
export class AzureBuilderEnabledGuard implements CanActivate {
  private readonly features: FeaturesController;

  constructor(config: ConfigService) {
    this.features = new FeaturesController(config);
  }

  canActivate(): boolean {
    if (!this.features.flags().azureBuilder) throw new NotFoundException('The Azure AI Factory Builder is not enabled on this server.');
    return true;
  }
}
