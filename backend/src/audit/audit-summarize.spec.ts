import { summarizeForAudit } from './audit-summarize';

describe('summarizeForAudit', () => {
  it('passes through undefined/null unchanged', () => {
    expect(summarizeForAudit(undefined)).toBeUndefined();
    expect(summarizeForAudit(null)).toBeNull();
  });

  it('redacts sensitive top-level fields', () => {
    const result: any = summarizeForAudit({ email: 'a@b.com', password: 'secret123' });
    expect(result.email).toBe('a@b.com');
    expect(result.password).toBe('[REDACTED]');
  });

  it('redacts sensitive fields nested inside objects and arrays', () => {
    const result: any = summarizeForAudit({ users: [{ email: 'a@b.com', accessToken: 'jwt-value' }] });
    expect(result.users[0].accessToken).toBe('[REDACTED]');
    expect(result.users[0].email).toBe('a@b.com');
  });

  it('is case-insensitive when matching sensitive keys', () => {
    const result: any = summarizeForAudit({ Password: 'x', TOKEN: 'y' });
    expect(result.Password).toBe('[REDACTED]');
    expect(result.TOKEN).toBe('[REDACTED]');
  });

  it('truncates a payload larger than maxLength', () => {
    const big = { text: 'x'.repeat(5000) };
    const result: any = summarizeForAudit(big, 100);
    expect(result.truncated).toBe(true);
    expect(result.preview.length).toBe(100);
  });

  it('leaves a small payload untouched (not wrapped in a truncation marker)', () => {
    const result = summarizeForAudit({ a: 1 }, 100);
    expect(result).toEqual({ a: 1 });
  });
});
