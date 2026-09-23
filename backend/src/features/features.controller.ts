import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

export interface FeatureFlags {
  /** AI Factory guided workflow (Waves 1+). Off by default so the existing VectorDB workflow is unchanged. */
  aiFactory: boolean;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Runtime feature flags for the UI. Read from the server environment so a flag
 * can be switched per environment without rebuilding the frontend. Contains
 * no sensitive data, so it is public like /health.
 */
@ApiTags('features')
@Controller('features')
export class FeaturesController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  flags(): FeatureFlags {
    return {
      aiFactory: TRUTHY.has(String(this.config.get<string>('AI_FACTORY_ENABLED') ?? '').trim().toLowerCase()),
    };
  }
}
