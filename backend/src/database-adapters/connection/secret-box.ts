import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Authenticated encryption for stored connection settings: AES-256-GCM with a
 * random 96-bit IV per value. Sealed form: `v1:<iv>:<tag>:<ciphertext>`, base64
 * parts. A changed byte, a wrong key or a truncated value fails to open -
 * nothing is ever decrypted into garbage.
 */

/** CONNECTION_SECRET_KEY: 32 bytes as 64 hex characters or base64. Anything else is no key. */
export function parseSecretKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const t = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  return key.length === 32 ? key : null;
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function unseal(sealed: string, key: Buffer): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognised sealed value.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
