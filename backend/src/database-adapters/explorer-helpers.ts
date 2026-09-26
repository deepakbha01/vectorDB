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

/** The whole vector as numbers (pgvector text, array or typed array), or undefined. */
export function fullVector(v: unknown): number[] | undefined {
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      return JSON.parse(v) as number[];
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) return v as number[];
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>);
  return undefined;
}

/** A record's preview, plus its whole vector when asked for. */
export function vectorFields(v: unknown, withVectors = false): { vectorPreview: number[] | null; dimension: number | null; vector?: number[] } {
  const p = vectorPreview(v);
  if (!withVectors) return p;
  const full = fullVector(v);
  return full ? { ...p, vector: full } : p;
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

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const field = (name: string) => {
  if (!FIELD.test(name)) throw new BadRequestException(`Invalid field name '${name}'.`);
  return name;
};

/** Pinecone / Chroma / MongoDB: `{ field: { $eq: value } }` per condition. */
function eqConditions(filter: ExplorerFilter): Array<Record<string, { $eq: string | number | boolean }>> {
  return Object.entries(filter).map(([name, value]) => ({ [field(name)]: { $eq: value } }));
}

/** Pinecone ANDs the keys of one object. */
export function pineconeFilter(filter: ExplorerFilter): Record<string, unknown> | undefined {
  const c = eqConditions(filter);
  return c.length ? Object.assign({}, ...c) : undefined;
}

/** Chroma needs an explicit $and for more than one condition. */
export function chromaWhere(filter: ExplorerFilter): Record<string, unknown> | undefined {
  const c = eqConditions(filter);
  return c.length === 0 ? undefined : c.length === 1 ? c[0] : { $and: c };
}

/** MongoDB: field names cannot start an operator or reach into a sub-document. */
export function mongoFilter(filter: ExplorerFilter): Record<string, unknown> {
  return Object.assign({}, ...eqConditions(filter));
}

/** Elasticsearch: exact `term` on keyword / numeric / boolean fields, `match_phrase` on analysed text. */
export function esFilter(filter: ExplorerFilter, fields: ExplorerField[]): Array<Record<string, unknown>> {
  const types = new Map(fields.map((f) => [f.name, f.type]));
  return Object.entries(filter).map(([name, value]) => (types.get(field(name)) === 'text' ? { match_phrase: { [name]: value } } : { term: { [name]: value } }));
}

/** Characters RediSearch treats as syntax inside a TAG value. */
const REDIS_TAG_SPECIAL = /[,.<>{}[\]"':;!@#$%^&*()\-+=~|/\\ ]/g;

/** RediSearch query syntax: TAG `@f:{v}`, NUMERIC `@f:[v v]`, TEXT `@f:"v"`, with special characters escaped. */
export function redisFilter(filter: ExplorerFilter, fields: ExplorerField[]): string {
  const types = new Map(fields.map((f) => [f.name, f.type.toUpperCase()]));
  return Object.entries(filter)
    .map(([name, value]) => {
      const t = types.get(field(name));
      if (t === 'NUMERIC') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new BadRequestException(`Field '${name}' is numeric.`);
        return `@${name}:[${n} ${n}]`;
      }
      const s = String(value);
      if (t === 'TEXT') return `@${name}:"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;
      return `@${name}:{${s.replace(REDIS_TAG_SPECIAL, (c) => `\\${c}`)}}`;
    })
    .join(' ');
}

/** SQL string literal with quotes doubled (LanceDB / DataFusion). */
export function sqlLiteral(v: string | number | boolean): string {
  return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v);
}

/** LanceDB `where` clause: backtick-quoted columns, escaped literals. */
export function lanceWhere(filter: ExplorerFilter): string {
  return Object.entries(filter)
    .map(([name, value]) => `\`${field(name)}\` = ${sqlLiteral(value)}`)
    .join(' AND ');
}

/** Oracle: `"COL" = :f0` per field, bound; columns come from the table's own catalogue (upper case). */
export function oracleWhere(filter: ExplorerFilter, columns: string[]): { sql: string; binds: Record<string, unknown> } {
  const allowed = new Set(columns.map((c) => c.toUpperCase()));
  const parts: string[] = [];
  const binds: Record<string, unknown> = {};
  Object.entries(filter).forEach(([name, value], i) => {
    const col = name.toUpperCase();
    if (!FIELD.test(name) || !allowed.has(col)) throw new BadRequestException(`Unknown column '${name}'.`);
    binds[`f${i}`] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    parts.push(`"${col}" = :f${i}`);
  });
  return { sql: parts.join(' AND '), binds };
}

/** Field names and JS types seen in a sample of schemaless records (Pinecone, Chroma, MongoDB). */
export function fieldsFromSample(records: Array<Record<string, unknown>>, skip: string[] = []): ExplorerField[] {
  const seen = new Map<string, string>();
  for (const r of records) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (skip.includes(k) || v === null || v === undefined || seen.has(k)) continue;
      seen.set(k, typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : 'string');
    }
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => ({ name, type }));
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
