const SENSITIVE_KEYS = new Set(['password', 'passwordhash', 'token', 'accesstoken', 'secret', 'apikey', 'authorization']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(v),
      ]),
    );
  }
  return value;
}

/** Redacts sensitive fields and truncates a request/response body for safe, bounded storage in the audit log. */
export function summarizeForAudit(value: unknown, maxLength = 2000): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  const redacted = redact(value);
  const json = JSON.stringify(redacted);
  if (json.length <= maxLength) {
    return redacted;
  }
  return { truncated: true, preview: json.slice(0, maxLength) };
}
