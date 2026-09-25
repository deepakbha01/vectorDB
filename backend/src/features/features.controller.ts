import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

export interface FeatureFlags {
  /** AI Factory guided workflow (Waves 1+). Off by default so the existing VectorDB workflow is unchanged. */
  aiFactory: boolean;
  /** Token Observability (Wave 12). Needs the AI Factory too - it is one of its phases. */
  tokenObservability: boolean;
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

  private on(key: string): boolean {
    return TRUTHY.has(String(this.config.get<string>(key) ?? '').trim().toLowerCase());
  }

  @Get()
  flags(): FeatureFlags {
    const aiFactory = this.on('AI_FACTORY_ENABLED');
    return {
      aiFactory,
      tokenObservability: aiFactory && this.on('TOKEN_OBSERVABILITY_ENABLED'),
    };
  }
}
