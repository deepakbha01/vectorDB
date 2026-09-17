import { BadRequestException } from '@nestjs/common';

/**
 * Sanitizes a user-supplied name into a safe SQL/Milvus identifier.
 * Shared by the Phase 2 schema generator (design-time DDL) and the Phase 4/5
 * database adapters (which execute that DDL, and interpolate table names into
 * queries, for real) so there is exactly one place that decides what counts
 * as a safe identifier.
 */
export function sanitizeSqlIdentifier(raw: string, context: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z_]+/, '')
    .slice(0, 63);
  if (!/[a-z0-9]/.test(sanitized)) {
    throw new BadRequestException(`${context} must contain at least one letter or digit.`);
  }
  return sanitized;
}
