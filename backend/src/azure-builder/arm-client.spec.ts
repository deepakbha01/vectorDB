import { ArmClient, ArmError, ArmTokenError, readArmToken } from './arm-client';

const TENANT = 'ef04bcd8-91ce-495c-9393-c645d394493c';
const NOW = new Date('2026-10-09T10:00:00Z');

/** An unsigned JWT with the given claims - enough for the claim checks, which never verify signatures. */
function fakeArmToken(claims: Record<string, unknown> = {}): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ aud: 'https://management.azure.com/', tid: TENANT, oid: 'o1', upn: 'architect@contoso.com', exp: Math.floor(NOW.getTime() / 1000) + 3600, ...claims })}.sig`;
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

describe('readArmToken', () => {
  it('reads the tenant, user and expiry of an ARM token for the registered tenant', () => {
    const c = readArmToken(fakeArmToken(), TENANT.toUpperCase(), NOW);
    expect(c).toMatchObject({ tenantId: TENANT, objectId: 'o1', userName: 'architect@contoso.com' });
    expect(c.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it.each([
    ['not a JWT', 'abc', /not a JWT/],
    ['a Microsoft Graph token', fakeArmToken({ aud: 'https://graph.microsoft.com' }), /not for Azure Resource Manager/],
    ['another tenant', fakeArmToken({ tid: '00000000-0000-4000-8000-000000000000' }), /registered in tenant/],
    ['an expired token', fakeArmToken({ exp: Math.floor(NOW.getTime() / 1000) - 1 }), /expired/],
    ['unreadable claims', 'a.!!!.c', /could not be read/],
  ])('refuses %s', (_label, token, message) => {
    expect(() => readArmToken(token, TENANT, NOW)).toThrow(ArmTokenError);
    expect(() => readArmToken(token, TENANT, NOW)).toThrow(message);
  });
});

describe('ArmClient', () => {
  const sleep = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => sleep.mockClear());

  it('sends the bearer token to management.azure.com and parses the JSON reply', async () => {
    const fetch = jest.fn().mockResolvedValue(reply(200, { displayName: 'Dev' }));
    const out = await new ArmClient('tok-123', { fetch, sleep }).get('/subscriptions/s1?api-version=2022-12-01');
    expect(out).toEqual({ displayName: 'Dev' });
    expect(fetch).toHaveBeenCalledWith('https://management.azure.com/subscriptions/s1?api-version=2022-12-01', expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }) }));
  });

  it('retries 429 and 5xx (honouring Retry-After) and then succeeds', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(reply(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(reply(503, ''))
      .mockResolvedValueOnce(reply(200, { ok: true }));
    await expect(new ArmClient('t', { fetch, sleep }).post('/providers/x', { q: 1 })).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 1000]);
  });

  it('gives up after the last attempt and reports ARM\'s error code and message, never the token', async () => {
    const fetch = jest.fn().mockResolvedValue(reply(500, { error: { code: 'InternalServerError', message: 'boom' } }));
    const err: any = await new ArmClient('secret-token', { fetch, sleep, maxAttempts: 2 }).get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ArmError);
    expect(err).toMatchObject({ status: 500, code: 'InternalServerError', message: 'boom' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(err) + err.message).not.toContain('secret-token');
  });

  it('does not retry a 403, and keeps a non-JSON body out of the message', async () => {
    const fetch = jest.fn().mockResolvedValue(reply(403, '<html>denied</html>'));
    const err = await new ArmClient('t', { fetch, sleep }).get('/x').catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: 'Http403', message: 'Azure returned HTTP 403.' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to send the token anywhere but management.azure.com', async () => {
    const fetch = jest.fn();
    await expect(new ArmClient('t', { fetch, sleep }).get('https://evil.example.com/steal')).rejects.toThrow('outside management.azure.com');
    await expect(new ArmClient('t', { fetch, sleep }).get('https://management.azure.com.evil.example.com/x')).rejects.toThrow('outside management.azure.com');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows nextLink pages of a list', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(reply(200, { value: [1, 2], nextLink: 'https://management.azure.com/next?page=2' }))
      .mockResolvedValueOnce(reply(200, { value: [3] }));
    await expect(new ArmClient('t', { fetch, sleep }).list('/things')).resolves.toEqual([1, 2, 3]);
  });
});
