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
 * search and A/B compare). Their audit entry says who searched what and how
 * many results came back - never the records, and not the query vector's values.
 */
const CONTENT_READ = /\/data-explorer\/collections\/[^/?]+\/(search|compare)(\?|$)/;

/**
 * A project's connection settings (PUT /connection, POST /connection/test).
 * Their audit entry names the settings changed - never a value, secret or not.
 */
const CONNECTION = /\/projects\/[^/?]+\/connection(\/test)?(\?|$)/;

type ConnectionView = { source?: unknown; connected?: unknown; latencyMs?: unknown; message?: unknown; removed?: unknown; fields?: Array<{ key?: unknown; set?: unknown }> };

function connectionSummaries(body: unknown, response: unknown): { requestSummary: unknown; responseSummary: unknown } {
  const settings = (body as { settings?: unknown } | undefined)?.settings;
  const names = settings && typeof settings === 'object' ? Object.keys(settings as object) : [];
  const r = (response ?? null) as ConnectionView | null;
  let responseSummary: unknown = null;
  if (r && typeof r === 'object') {
    responseSummary = Array.isArray(r.fields)
      ? { source: r.source, set: r.fields.filter((f) => f.set).map((f) => f.key) }
      : { source: r.source, connected: r.connected, latencyMs: r.latencyMs, removed: r.removed, message: typeof r.message === 'string' ? r.message.slice(0, 300) : r.message };
  }
  return { requestSummary: { settings: names }, responseSummary };
}

type SearchBody = { text?: unknown; vector?: unknown; vectorName?: unknown; mode?: unknown; alpha?: unknown; topK?: unknown; filter?: unknown; a?: SearchBody; b?: SearchBody };
type SearchReply = { results?: unknown[]; latencyMs?: unknown; a?: SearchReply; b?: SearchReply; overlap?: { shared?: unknown } };

export function auditSummaries(url: string, body: unknown, response: unknown): { requestSummary: unknown; responseSummary: unknown } {
  if (CONNECTION.test(url)) return connectionSummaries(body, response);
  if (CONTENT_READ.test(url)) {
    const b = (body ?? {}) as SearchBody;
    const side = (s: SearchBody | undefined) => (s ? { mode: s.mode, alpha: s.alpha, topK: s.topK, filter: s.filter, vectorName: s.vectorName } : undefined);
    const count = (r: SearchReply | undefined) => (r && typeof r === 'object' ? { results: Array.isArray(r.results) ? r.results.length : null, latencyMs: r.latencyMs ?? null } : null);
    const r = response as SearchReply | undefined;
    return {
      requestSummary: summarizeForAudit({ text: b.text, vector: Array.isArray(b.vector) ? `${b.vector.length} dimensions` : undefined, ...side(b), a: side(b.a), b: side(b.b) }),
      responseSummary: r && typeof r === 'object' ? (r.a || r.b ? { a: count(r.a), b: count(r.b), shared: r.overlap?.shared ?? null } : count(r)) : null,
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
