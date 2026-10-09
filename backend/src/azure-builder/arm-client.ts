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

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  /** DELETE; 200, 202 (accepted, finishing asynchronously) and 204 all count as done here. */
  async delete(path: string): Promise<void> {
    await this.request<unknown>('DELETE', path);
  }

  /**
   * A POST that ARM may answer with 202 Accepted (e.g. what-if): polls the Location (or
   * Azure-AsyncOperation) URL until it returns the result, for at most `maxWaitMs`.
   */
  async postLongRunning<T>(path: string, body: unknown, maxWaitMs = 300_000): Promise<T> {
    let res = await this.send('POST', this.url(path), body);
    const started = Date.now();
    while (res.status === 202) {
      const next = res.headers.get('location') ?? res.headers.get('azure-asyncoperation');
      if (!next) throw new ArmError(202, 'NoLocation', 'Azure accepted the request but gave no address to poll for the result.');
      if (Date.now() - started > maxWaitMs) throw new ArmError(0, 'Timeout', `Azure did not finish within ${Math.round(maxWaitMs / 1000)} s.`);
      await this.sleep(this.retryDelay(res.headers.get('retry-after'), 5000));
      res = await this.send('GET', this.url(next));
    }
    return this.parse<T>(res);
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
    return this.parse<T>(await this.send(method, this.url(path), body));
  }

  private url(path: string): string {
    const url = path.startsWith('https://') ? path : `${ARM}${path}`;
    if (!url.startsWith(`${ARM}/`)) throw new ArmError(0, 'InvalidUrl', 'Refusing to send the Azure token outside management.azure.com.');
    return url;
  }

  private retryDelay(retryAfter: string | null, fallbackMs: number): number {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : fallbackMs;
  }

  /** One call with retries on 429 and 5xx; returns any other response as it is. */
  private async send(method: string, url: string, body?: unknown): Promise<{ status: number; headers: { get(name: string): string | null }; text: string }> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxAttempts) {
        await this.sleep(this.retryDelay(res.headers.get('retry-after'), 500 * 2 ** (attempt - 1)));
        continue;
      }
      return { status: res.status, headers: res.headers, text };
    }
  }

  private parse<T>(res: { status: number; text: string }): T {
    if (res.status >= 200 && res.status < 300) return (res.text ? JSON.parse(res.text) : {}) as T;
    throw armErrorFrom(res.status, res.text);
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
