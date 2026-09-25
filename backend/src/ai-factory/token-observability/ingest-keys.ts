import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Ingest key format: `aftk_<prefix>_<secret>`. The prefix (12 hex chars) is
 * stored and used to find the key; the whole key is only ever stored as a
 * SHA-256 hash. Keys are 192-bit random, so a fast hash is appropriate (this
 * is not a password).
 */
const PATTERN = /^aftk_([0-9a-f]{12})_([A-Za-z0-9_-]{32})$/;

export function generateIngestKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('hex');
  const key = `aftk_${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, prefix, hash: hashIngestKey(key) };
}

export const hashIngestKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

/** The lookup prefix, or null when the value cannot be an ingest key at all. */
export function prefixOf(key: string): string | null {
  return PATTERN.exec(key)?.[1] ?? null;
}

export function matchesHash(key: string, storedHash: string): boolean {
  const a = Buffer.from(hashIngestKey(key), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads the key from `Authorization: Bearer <key>` or `X-Ingest-Key`. */
export function keyFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'];
  const bearer = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth)?.[1] : undefined;
  const header = headers['x-ingest-key'];
  return bearer ?? (typeof header === 'string' ? header.trim() : null) ?? null;
}
