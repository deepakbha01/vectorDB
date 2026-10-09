/**
 * Azure AI Factory Builder - live Azure (Wave 6). A minimal Azure Resource
 * Manager REST client for the user's delegated ARM token (spec 9.1-9.2).
 *
 * The token comes from the browser (MSAL, scope management.azure.com/user_impersonation)
 * on each request. It is held only by this object for the request's lifetime -
 * never written to the database, a log line or an error message (spec 4.1).
 */

export const ARM = 'https://management.azure.com';

/** ARM audiences an Entra-issued management token may carry. */
const ARM_AUDIENCES = new Set(['https://management.azure.com', 'https://management.azure.com/', 'https://management.core.windows.net', 'https://management.core.windows.net/']);

export class ArmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A token the request cannot use - wrong audience, wrong tenant, expired or unreadable. */
export class ArmTokenError extends Error {}

export interface ArmTokenClaims {
  tenantId: string;
  objectId: string | null;
  userName: string | null;
  expiresAt: Date;
}

/**
 * Reads the token's claims to refuse an obvious mismatch early (another tenant, a
 * Graph token, an expired one). This is not signature verification - ARM verifies
 * the token on every call; this only stops a call that is bound to fail or that
 * targets a tenant the app is not registered in.
 */
export function readArmToken(token: string, expectedTenantId: string, now = new Date()): ArmTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ArmTokenError('The Azure token is not a JWT - sign in to Azure again.');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new ArmTokenError('The Azure token could not be read - sign in to Azure again.');
  }
  if (!ARM_AUDIENCES.has(String(claims.aud))) throw new ArmTokenError('The Azure token is not for Azure Resource Manager - sign in to Azure again.');
  const tenantId = String(claims.tid ?? '');
  if (tenantId.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new ArmTokenError(`The Azure token is for tenant ${tenantId || 'unknown'}, but this server is registered in tenant ${expectedTenantId}.`);
  }
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) throw new ArmTokenError('The Azure token has no expiry - sign in to Azure again.');
  const expiresAt = new Date(exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) throw new ArmTokenError('The Azure sign-in has expired - sign in to Azure again.');
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { tenantId, objectId: str(claims.oid), userName: str(claims.upn) ?? str(claims.unique_name) ?? str(claims.preferred_username), expiresAt };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface ArmClientOptions {
  fetch?: FetchLike;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/** ARM REST calls with the user's token; retries 429 and 5xx with backoff (spec 5.3). */
export class ArmClient {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(
    private readonly token: string,
    options: ArmClientOptions = {},
  ) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** Follows nextLink pages of a list call, up to `maxItems`. */
  async list<T>(path: string, maxItems = 5000): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    while (next && items.length < maxItems) {
      const page: { value?: T[]; nextLink?: string } = await this.get(next);
      items.push(...(page.value ?? []));
      next = page.nextLink ?? null;
    }
    return items.slice(0, maxItems);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('https://') ? path : `${ARM}${path}`;
    if (!url.startsWith(`${ARM}/`)) throw new ArmError(0, 'InvalidUrl', 'Refusing to send the Azure token outside management.azure.com.');
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) return (text ? JSON.parse(text) : {}) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** (attempt - 1));
        continue;
      }
      throw armErrorFrom(res.status, text);
    }
  }
}

function armErrorFrom(status: number, text: string): ArmError {
  let code = `Http${status}`;
  let message = `Azure returned HTTP ${status}.`;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (parsed.error?.code) code = parsed.error.code;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Not JSON - keep the generic message rather than echoing an arbitrary body.
  }
  return new ArmError(status, code, message.slice(0, 500));
}
