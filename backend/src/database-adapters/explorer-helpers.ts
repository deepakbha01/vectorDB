import { BadRequestException } from '@nestjs/common';
import { ExplorerField, ExplorerFilter } from './vector-explorer';

/**
 * Pure helpers shared by the Data Explorer implementations of the adapters:
 * value trimming, vector previews, and the per-database filter translations.
 * Every translation takes only field names the database itself reported, and
 * binds or escapes every value - nothing from the request reaches a query raw.
 */

export const PREVIEW_COMPONENTS = 8;
export const MAX_VALUE_CHARS = 1000;

/** Long text (chunk bodies, JSON blobs) is shortened; the explorer is for inspection, not export. */
export function trimValue(v: unknown, max = MAX_VALUE_CHARS): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}… (${v.length.toLocaleString('en-US')} characters)` : v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}… (${s.length.toLocaleString('en-US')} characters)` : v;
  }
  return v;
}

export function trimMetadata(m: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, trimValue(v)]));
}

/** A vector as pgvector text ("[0.1,0.2]"), an array, or a typed array → its first components and length. */
export function vectorPreview(v: unknown): { vectorPreview: number[] | null; dimension: number | null } {
  let arr: number[] | null = null;
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      arr = JSON.parse(v) as number[];
    } catch {
      arr = null;
    }
  } else if (Array.isArray(v)) arr = v as number[];
  else if (ArrayBuffer.isView(v) && !(v instanceof DataView)) arr = Array.from(v as unknown as ArrayLike<number>);
  if (!arr || !arr.length || typeof arr[0] !== 'number') return { vectorPreview: null, dimension: null };
  return { vectorPreview: arr.slice(0, PREVIEW_COMPONENTS).map((x) => Math.round(x * 1e6) / 1e6), dimension: arr.length };
}

/**
 * Converts filter values (which arrive as text) to each field's type, and
 * refuses fields the collection does not have - so a typo is a clear error,
 * not an empty page.
 */
export function coerceFilter(filter: ExplorerFilter, fields: ExplorerField[]): ExplorerFilter {
  const byName = new Map(fields.map((f) => [f.name, f.type.toLowerCase()]));
  const out: ExplorerFilter = {};
  for (const [name, raw] of Object.entries(filter)) {
    const type = byName.get(name);
    if (type === undefined) throw new BadRequestException(`The collection has no field '${name}'. Fields: ${[...byName.keys()].join(', ') || 'none'}.`);
    const text = String(raw);
    if (/bool/.test(type)) {
      if (!/^(true|false)$/i.test(text)) throw new BadRequestException(`Field '${name}' is boolean; use true or false.`);
      out[name] = text.toLowerCase() === 'true';
    } else if (/int|float|double|numeric|real|decimal|number/.test(type)) {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new BadRequestException(`Field '${name}' is numeric; '${text}' is not a number.`);
      out[name] = n;
    } else out[name] = text;
  }
  return out;
}

/** pgvector: `col = $n` per field; columns come from the table's own catalogue. */
export function pgWhere(filter: ExplorerFilter, columns: string[], firstParam: number): { sql: string; params: unknown[] } {
  const allowed = new Set(columns);
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [name, value] of Object.entries(filter)) {
    if (!allowed.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BadRequestException(`Unknown column '${name}'.`);
    params.push(value);
    parts.push(`"${name}" = $${firstParam + params.length - 1}`);
  }
  return { sql: parts.join(' AND '), params };
}

/** Qdrant: every condition must match (payload keys are data, not code, in Qdrant's filter JSON). */
export function qdrantFilter(filter: ExplorerFilter): { must: Array<{ key: string; match: { value: string | number | boolean } }> } | undefined {
  const must = Object.entries(filter).map(([key, value]) => ({ key, match: { value } }));
  return must.length ? { must } : undefined;
}

/** Milvus boolean expression: `f == "v" and g == 3`, with strings escaped and field names checked. */
export function milvusExpr(filter: ExplorerFilter): string {
  return Object.entries(filter)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BadRequestException(`Invalid field name '${name}'.`);
      if (typeof value === 'string') return `${name} == "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      return `${name} == ${String(value)}`;
    })
    .join(' and ');
}

/** Maps each database's metric names onto the platform's SimilarityMetric values. */
export function normaliseMetric(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.toLowerCase();
  if (m.includes('cosine')) return 'cosine';
  if (m === 'ip' || m.includes('_ip_') || m.includes('dot')) return 'dot_product';
  if (m === 'l2' || m.includes('l2') || m.includes('euclid')) return 'euclidean';
  return raw;
}

/** Maps each database's index names onto the Index Design choices (hnsw | ivf_flat | pq). */
export function normaliseIndexType(raw: string): string {
  const t = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (t.includes('hnsw')) return 'hnsw';
  if (t.includes('pq')) return 'pq';
  if (t.includes('ivfflat') || t === 'ivf') return 'ivf_flat';
  return 'other';
}
