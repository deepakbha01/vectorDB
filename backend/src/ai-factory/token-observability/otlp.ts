/**
 * OTLP/HTTP JSON traces → normalized usage events (spec §11) - pure, no I/O.
 *
 * Only GenAI spans are used: a span must carry an operation name (by default
 * gen_ai.operation.name). Everything else in the export (HTTP, DB spans, ...)
 * is skipped, not rejected. Prompt / completion content attributes are never
 * read - only the configured usage and identity attributes are.
 */

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: unknown; kvlistValue?: unknown; bytesValue?: string };
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number | string; message?: string };
}
export interface OtlpTracesRequest {
  resourceSpans?: Array<{ resource?: { attributes?: KeyValue[] }; scopeSpans?: Array<{ spans?: OtlpSpan[] }>; instrumentationLibrarySpans?: Array<{ spans?: OtlpSpan[] }> }>;
}

export interface OtelMapping {
  span: Record<string, string[]>;
  resource: Record<string, string[]>;
}

const NUMERIC = new Set(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'embeddingTokens', 'rerankingTokens', 'contextTokens', 'retrievalCount', 'ttftMs']);

function scalar(v: AnyValue | undefined): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

const toMap = (kvs: KeyValue[] | undefined) => new Map((kvs ?? []).map((kv) => [kv.key, scalar(kv.value)] as const));

/** Nanoseconds since epoch (string or number) → milliseconds, without losing precision on the way. */
function nanosToMs(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  try {
    return Number(BigInt(String(v).split('.')[0]) / 1_000_000n);
  } catch {
    return null;
  }
}

export interface MappedSpans {
  /** Event objects ready for validation, each with where it came from. */
  events: Array<{ ref: string; event: Record<string, unknown> }>;
  /** Spans that are not GenAI calls. */
  skipped: number;
  /** Spans that are GenAI calls but cannot be used (e.g. no ids or time). */
  rejected: Array<{ ref: string; reason: string }>;
}

export function mapOtlpTraces(body: OtlpTracesRequest, mapping: OtelMapping): MappedSpans {
  const out: MappedSpans = { events: [], skipped: 0, rejected: [] };
  for (const rs of body?.resourceSpans ?? []) {
    const resource = toMap(rs.resource?.attributes);
    for (const ss of [...(rs.scopeSpans ?? []), ...(rs.instrumentationLibrarySpans ?? [])]) {
      for (const span of ss.spans ?? []) {
        const attrs = toMap(span.attributes);
        const pick = (field: string): string | number | boolean | undefined => {
          for (const k of mapping.span[field] ?? []) if (attrs.get(k) !== undefined && attrs.get(k) !== '') return attrs.get(k);
          for (const k of mapping.resource[field] ?? []) if (resource.get(k) !== undefined && resource.get(k) !== '') return resource.get(k);
          return undefined;
        };
        const operationType = pick('operationType');
        if (operationType === undefined) {
          out.skipped++;
          continue;
        }
        const ref = `${span.traceId ?? '?'}/${span.spanId ?? '?'}`;
        const start = nanosToMs(span.startTimeUnixNano);
        const end = nanosToMs(span.endTimeUnixNano);
        if (!span.traceId || !span.spanId) {
          out.rejected.push({ ref, reason: 'span has no traceId or spanId' });
          continue;
        }
        if (start === null) {
          out.rejected.push({ ref, reason: 'span has no start time' });
          continue;
        }
        const event: Record<string, unknown> = {
          eventId: `${span.traceId}-${span.spanId}`,
          timestamp: new Date(start).toISOString(),
          traceId: span.traceId,
          spanId: span.spanId,
          operationType: String(operationType),
        };
        if (span.parentSpanId) event.parentSpanId = span.parentSpanId;
        if (end !== null && end >= start) event.latencyMs = end - start;
        for (const field of new Set([...Object.keys(mapping.span), ...Object.keys(mapping.resource)])) {
          if (field === 'operationType') continue;
          const v = pick(field);
          if (v === undefined) continue;
          event[field] = NUMERIC.has(field) ? Math.round(Number(v)) : String(v);
        }
        // requestId defaults to the trace: one user request is one trace.
        event.requestId ??= span.traceId;
        // Tool and embedding spans often report no provider / model; the event still needs both.
        event.provider ??= 'unknown';
        event.model ??= event.toolName ?? 'unknown';
        // OTLP status code 2 = ERROR (JSON may carry the enum name).
        const code = span.status?.code;
        if (code === 2 || code === 'STATUS_CODE_ERROR') {
          event.requestStatus = 'error';
          event.errorType ??= 'error';
        }
        out.events.push({ ref, event });
      }
    }
  }
  return out;
}
