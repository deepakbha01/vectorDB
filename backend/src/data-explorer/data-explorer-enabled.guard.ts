import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeaturesController } from '../features/features.controller';

/** Hides every Data Explorer endpoint unless DATA_EXPLORER_ENABLED is on, parsed exactly as GET /api/features does. */
@Injectable()
export class DataExplorerEnabledGuard implements CanActivate {
  private readonly features: FeaturesController;

  constructor(config: ConfigService) {
    this.features = new FeaturesController(config);
  }

  canActivate(): boolean {
    if (!this.features.flags().dataExplorer) throw new NotFoundException('The Data Explorer is not enabled on this server.');
    return true;
  }
}
