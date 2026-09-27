import { IsObject, IsOptional } from 'class-validator';

/**
 * Connection settings by TARGET_* name. In an update an omitted setting keeps
 * its stored value and an empty string clears it; the service checks names
 * and values against the platform's fields.
 */
export class ConnectionSettingsDto {
  @IsObject()
  settings: Record<string, unknown>;
}

/** Settings to try before saving; merged over the stored ones like an update. */
export class ConnectionTestDto {
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
