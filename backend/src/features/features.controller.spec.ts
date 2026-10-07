import { ConfigService } from '@nestjs/config';
import { FeaturesController } from './features.controller';

const controllerWith = (value: string | undefined) => new FeaturesController({ get: () => value } as unknown as ConfigService);
const controllerWithEnv = (env: Record<string, string>) => new FeaturesController({ get: (k: string) => env[k] } as unknown as ConfigService);

describe('FeaturesController', () => {
  it('keeps the AI Factory workflow off when the flag is unset', () => {
    expect(controllerWith(undefined).flags()).toEqual({ aiFactory: false, tokenObservability: false, dataExplorer: false, azureBuilder: false });
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])('turns it on for %p', (v) => {
    expect(controllerWith(v).flags().aiFactory).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', '', 'enabled?'])('keeps it off for %p', (v) => {
    expect(controllerWith(v).flags().aiFactory).toBe(false);
  });

  it('turns Token Observability on only together with the AI Factory', () => {
    expect(controllerWithEnv({ AI_FACTORY_ENABLED: 'true', TOKEN_OBSERVABILITY_ENABLED: 'true' }).flags().tokenObservability).toBe(true);
    expect(controllerWithEnv({ AI_FACTORY_ENABLED: 'true' }).flags().tokenObservability).toBe(false);
    expect(controllerWithEnv({ TOKEN_OBSERVABILITY_ENABLED: 'true' }).flags().tokenObservability).toBe(false);
  });

  it('turns the Data Explorer on by its own flag, independent of the AI Factory', () => {
    expect(controllerWithEnv({ DATA_EXPLORER_ENABLED: 'true' }).flags()).toEqual({ aiFactory: false, tokenObservability: false, dataExplorer: true, azureBuilder: false });
    expect(controllerWithEnv({ AI_FACTORY_ENABLED: 'true' }).flags().dataExplorer).toBe(false);
  });

  it('turns the Azure Builder on by its own flag, independent of the AI Factory', () => {
    expect(controllerWithEnv({ AZURE_BUILDER_ENABLED: 'true' }).flags()).toEqual({ aiFactory: false, tokenObservability: false, dataExplorer: false, azureBuilder: true });
    expect(controllerWithEnv({ AI_FACTORY_ENABLED: 'true' }).flags().azureBuilder).toBe(false);
  });
});
