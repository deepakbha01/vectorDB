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

/**
 * Reads of customer records from a target vector database (Data Explorer
 * search). Their audit entry says who searched what and how many results came
 * back - never the records, and not the query vector's values.
 */
const CONTENT_READ = /\/data-explorer\/collections\/[^/?]+\/search(\?|$)/;

export function auditSummaries(url: string, body: unknown, response: unknown): { requestSummary: unknown; responseSummary: unknown } {
  if (CONTENT_READ.test(url)) {
    const b = (body ?? {}) as { text?: unknown; vector?: unknown; topK?: unknown; filter?: unknown };
    const r = response as { results?: unknown[]; latencyMs?: unknown } | undefined;
    return {
      requestSummary: summarizeForAudit({ text: b.text, vector: Array.isArray(b.vector) ? `${b.vector.length} dimensions` : undefined, topK: b.topK, filter: b.filter }),
      responseSummary: r && typeof r === 'object' ? { results: Array.isArray(r.results) ? r.results.length : null, latencyMs: r.latencyMs ?? null } : null,
    };
  }
  return { requestSummary: summarizeForAudit(body), responseSummary: summarizeForAudit(response) };
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
