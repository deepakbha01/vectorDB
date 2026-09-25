import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UsageEventDto } from './dto/usage-events.dto';
import { UploadRejection } from './simulation-run.entity';

/**
 * Parsing uploaded load-test / benchmark results (spec §12 Simulated mode) -
 * pure, no I/O. Accepts the spec §10 field names (snake_case) or the API's
 * (camelCase), as JSON (an array, or { events: [...] }) or CSV with a header
 * row. Every row is validated exactly like the ingest API.
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_EVENTS = 100_000;

const NUMERIC = new Set([
  'inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens', 'totalTokens', 'embeddingTokens', 'rerankingTokens', 'contextTokens',
  'retrievalCount', 'toolCallCount', 'llmCallCount', 'latencyMs', 'ttftMs',
]);

/** Spec §10 fields the server sets itself; accepted in a file but ignored, never trusted. */
const SERVER_SET = new Set(['projectId', 'estimatedInputCost', 'estimatedOutputCost', 'estimatedTotalCost', 'currency', 'telemetrySource', 'createdAt']);

const camel = (k: string) => k.trim().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export interface ParsedUpload {
  format: 'csv' | 'json';
  events: UsageEventDto[];
  /** The file row of each event, for reporting rejections found later (e.g. a future timestamp). */
  eventRows: number[];
  rejections: UploadRejection[];
  received: number;
  /** Server-set columns present in the file and ignored. */
  ignoredFields: string[];
}

export function parseUpload(content: string, fileName: string, projectId: string): ParsedUpload | { error: string } {
  const text = content.replace(/^﻿/, '');
  const format: 'csv' | 'json' = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text) ? 'json' : 'csv';
  let rows: Array<Record<string, unknown>>;
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { error: `Not valid JSON: ${(e as Error).message}` };
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown })?.events;
    if (!Array.isArray(list)) return { error: 'JSON must be an array of events or an object with an "events" array.' };
    rows = list.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { __invalid: true }));
  } else {
    const table = parseCsv(text);
    if ('error' in table) return table;
    const [header, ...data] = table.rows;
    if (!header?.length) return { error: 'The CSV has no header row.' };
    rows = data.filter((r) => r.some((c) => c.trim() !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }
  if (rows.length === 0) return { error: 'The file contains no events.' };
  if (rows.length > MAX_UPLOAD_EVENTS) return { error: `The file has ${rows.length.toLocaleString()} events; the limit is ${MAX_UPLOAD_EVENTS.toLocaleString()} per upload.` };

  const events: UsageEventDto[] = [];
  const eventRows: number[] = [];
  const rejections: UploadRejection[] = [];
  const ignored = new Set<string>();
  rows.forEach((raw, i) => {
    const row = i + 1;
    if ('__invalid' in raw) {
      rejections.push({ row, eventId: null, reason: 'not an object' });
      return;
    }
    const obj: Record<string, unknown> = {};
    const original = new Map<string, string>();
    let reason: string | null = null;
    for (const [k, v] of Object.entries(raw)) {
      const key = camel(k);
      original.set(key, k);
      if (v === '' || v === null || v === undefined) continue;
      if (SERVER_SET.has(key)) {
        // A row for another project is refused; the rest is recomputed here.
        if (key === 'projectId' && String(v) !== projectId) reason = `project_id ${String(v)} is not this project`;
        ignored.add(k);
        continue;
      }
      if (NUMERIC.has(key) && typeof v === 'string') {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          reason = `${k} is not a number`;
          continue;
        }
        obj[key] = n;
      } else obj[key] = v;
    }
    const eventId = typeof obj.eventId === 'string' ? obj.eventId : null;
    if (reason) {
      rejections.push({ row, eventId, reason });
      return;
    }
    const dto = plainToInstance(UsageEventDto, obj);
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      // Name the column as the file does (service_id, not serviceId).
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}).map((m) => (original.has(e.property) ? m.replace(e.property, original.get(e.property)!) : m)));
      rejections.push({ row, eventId, reason: messages.join('; ') });
      return;
    }
    events.push(dto);
    eventRows.push(row);
  });
  return { format, events, eventRows, rejections, received: rows.length, ignoredFields: [...ignored] };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): { rows: string[][] } | { error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) return { error: 'The CSV has an unterminated quoted field.' };
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows };
}

/** Column order for the downloadable template (spec §10 names). */
export const TEMPLATE_COLUMNS = [
  'event_id', 'timestamp', 'request_id', 'trace_id', 'span_id', 'parent_span_id', 'tenant_id', 'application_id', 'service_id', 'workflow_id', 'agent_id',
  'session_id', 'provider', 'model', 'model_version', 'operation_type', 'rag_stage', 'tool_name', 'environment', 'region', 'input_tokens', 'output_tokens',
  'reasoning_tokens', 'cached_input_tokens', 'total_tokens', 'embedding_tokens', 'reranking_tokens', 'context_tokens', 'retrieval_count', 'tool_call_count',
  'llm_call_count', 'latency_ms', 'ttft_ms', 'request_status', 'error_type',
];
