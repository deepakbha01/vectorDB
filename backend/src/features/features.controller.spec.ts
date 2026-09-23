import { ConfigService } from '@nestjs/config';
import { FeaturesController } from './features.controller';

const controllerWith = (value: string | undefined) => new FeaturesController({ get: () => value } as unknown as ConfigService);

describe('FeaturesController', () => {
  it('keeps the AI Factory workflow off when the flag is unset', () => {
    expect(controllerWith(undefined).flags()).toEqual({ aiFactory: false });
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])('turns it on for %p', (v) => {
    expect(controllerWith(v).flags().aiFactory).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', '', 'enabled?'])('keeps it off for %p', (v) => {
    expect(controllerWith(v).flags().aiFactory).toBe(false);
  });
});
