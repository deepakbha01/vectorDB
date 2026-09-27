import { BadRequestException } from '@nestjs/common';
import { ExplorerField, ExplorerFilter, ExplorerRecordDetail, FilterCondition, FilterOp, FilterValue, NO_FILTER } from './vector-explorer';

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

/**
 * A record's vector from what the database returns: a plain array, or an
 * object of named vectors - the one asked for, else the first.
 */
export function pickVector(v: unknown, name?: string): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return v;
  if (typeof v !== 'object') return undefined;
  const named = v as Record<string, unknown>;
  return name ? named[name] : Object.values(named)[0];
}

export function trimMetadata(m: Record<string, unknown>, max = MAX_VALUE_CHARS): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, trimValue(v, max)]));
}

/** The record detail view shows much longer values than a listing. */
export const DETAIL_VALUE_CHARS = 20_000;
export const DETAIL_COMPONENTS = 64;

/** One record in full: metadata up to 20,000 characters per value, the first 64 vector values, its dimension and L2 norm. */
export function recordDetail(id: string, metadata: Record<string, unknown>, vector: unknown): ExplorerRecordDetail {
  const v = fullVector(vector);
  return {
    id,
    metadata: trimMetadata(metadata, DETAIL_VALUE_CHARS),
    dimension: v ? v.length : null,
    vectorHead: v ? v.slice(0, DETAIL_COMPONENTS).map((x) => Math.round(x * 1e6) / 1e6) : null,
    norm: v ? Math.round(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) * 1e6) / 1e6 : null,
  };
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

export const MAX_FILTER_CONDITIONS = 5;
export const MAX_IN_VALUES = 20;
const OPS: FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'];
const RANGE: FilterOp[] = ['gt', 'gte', 'lt', 'lte'];

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const field = (name: string) => {
  if (!FIELD.test(name)) throw new BadRequestException(`Invalid field name '${name}'.`);
  return name;
};
const isNumericType = (type: string) => /int|float|double|numeric|real|decimal|number/.test(type.toLowerCase());
const isBoolType = (type: string) => /bool/.test(type.toLowerCase());

/**
 * Accepts the structured form `{ combine: 'and' | 'or', conditions: [{ field, op, value }] }`
 * or the short form `{ field: value, ... }` (all equal).
 */
export function parseFilterInput(raw: unknown): ExplorerFilter {
  if (raw === undefined || raw === null) return NO_FILTER;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('filter must be an object.');
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.conditions)) {
    const combine = o.combine === undefined ? 'and' : o.combine;
    if (combine !== 'and' && combine !== 'or') throw new BadRequestException("filter.combine must be 'and' or 'or'.");
    return {
      combine,
      conditions: (o.conditions as unknown[]).map((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        if (typeof x.field !== 'string') throw new BadRequestException('Each filter condition needs a field.');
        const op = (x.op ?? 'eq') as FilterOp;
        if (!OPS.includes(op)) throw new BadRequestException(`Unknown filter operator '${String(x.op)}'. Use one of ${OPS.join(', ')}.`);
        return { field: x.field, op, value: x.value as FilterCondition['value'] };
      }),
    };
  }
  return { combine: 'and', conditions: Object.entries(o).map(([f, value]) => ({ field: f, op: 'eq' as const, value: value as FilterValue })) };
}

/** The fields a filter uses. */
export const filterFields = (f: ExplorerFilter) => [...new Set(f.conditions.map((c) => c.field))];

function coerceOne(name: string, type: string, raw: unknown): FilterValue {
  if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new BadRequestException(`Filter value for '${name}' must be text, a number or true / false.`);
  const text = String(raw);
  if (text.length > 200) throw new BadRequestException(`Filter value for '${name}' is too long.`);
  if (isBoolType(type)) {
    if (!/^(true|false)$/i.test(text)) throw new BadRequestException(`Field '${name}' is boolean; use true or false.`);
    return text.toLowerCase() === 'true';
  }
  if (isNumericType(type)) {
    const n = Number(text);
    if (!Number.isFinite(n) || text.trim() === '') throw new BadRequestException(`Field '${name}' is numeric; '${text}' is not a number.`);
    return n;
  }
  return text;
}

/**
 * Checks every condition against the collection's own fields and converts its
 * value to the field's type: a typo or a wrong type is a clear error, not an
 * empty page. Range comparisons need a numeric field; "in" takes up to 20
 * values (an array, or comma-separated text).
 */
export function coerceFilter(filter: ExplorerFilter, fields: ExplorerField[]): ExplorerFilter {
  if (filter.conditions.length > MAX_FILTER_CONDITIONS) throw new BadRequestException(`At most ${MAX_FILTER_CONDITIONS} filter conditions.`);
  const byName = new Map(fields.map((f) => [f.name, f.type]));
  return {
    combine: filter.combine,
    conditions: filter.conditions.map((c) => {
      const type = byName.get(c.field);
      if (type === undefined) throw new BadRequestException(`The collection has no field '${c.field}'. Fields: ${[...byName.keys()].join(', ') || 'none'}.`);
      if (RANGE.includes(c.op) && !isNumericType(type)) throw new BadRequestException(`'${c.field}' is not numeric, so it cannot be compared with ${c.op}; use = or ≠.`);
      if (c.op === 'in') {
        if (isBoolType(type)) throw new BadRequestException(`'${c.field}' is boolean; use = instead of "in".`);
        const list = Array.isArray(c.value) ? c.value : String(c.value).split(',').map((v) => v.trim()).filter((v) => v !== '');
        if (!list.length || list.length > MAX_IN_VALUES) throw new BadRequestException(`"in" takes 1-${MAX_IN_VALUES} values.`);
        return { field: c.field, op: c.op, value: list.map((v) => coerceOne(c.field, type, v)) };
      }
      if (Array.isArray(c.value)) throw new BadRequestException(`Only "in" takes a list of values ('${c.field}').`);
      return { field: c.field, op: c.op, value: coerceOne(c.field, type, c.value) };
    }),
  };
}

const list = (v: FilterCondition['value']): FilterValue[] => (Array.isArray(v) ? v : [v]);
const single = (v: FilterCondition['value']): FilterValue => (Array.isArray(v) ? v[0] : v);
const SQL_OP: Record<Exclude<FilterOp, 'in'>, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const joinSql = (parts: string[], combine: 'and' | 'or') => (parts.length > 1 && combine === 'or' ? `(${parts.join(' OR ')})` : parts.join(combine === 'or' ? ' OR ' : ' AND '));

/** pgvector: bound parameters on real columns; "in" as `= ANY($n)`. */
export function pgWhere(filter: ExplorerFilter, columns: string[], firstParam: number): { sql: string; params: unknown[] } {
  const allowed = new Set(columns);
  const params: unknown[] = [];
  const parts = filter.conditions.map((c) => {
    if (!allowed.has(c.field) || !FIELD.test(c.field)) throw new BadRequestException(`Unknown column '${c.field}'.`);
    params.push(c.op === 'in' ? list(c.value) : single(c.value));
    const p = `$${firstParam + params.length - 1}`;
    return c.op === 'in' ? `"${c.field}" = ANY(${p})` : `"${c.field}" ${SQL_OP[c.op]} ${p}`;
  });
  return { sql: joinSql(parts, filter.combine), params };
}

/** Oracle: bound `"COL" op :fN` on real (upper-case) columns; booleans as 1 / 0. */
export function oracleWhere(filter: ExplorerFilter, columns: string[]): { sql: string; binds: Record<string, unknown> } {
  const allowed = new Set(columns.map((c) => c.toUpperCase()));
  const binds: Record<string, unknown> = {};
  const bind = (v: FilterValue) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const parts = filter.conditions.map((c, i) => {
    const col = c.field.toUpperCase();
    if (!FIELD.test(c.field) || !allowed.has(col)) throw new BadRequestException(`Unknown column '${c.field}'.`);
    if (c.op === 'in') {
      const names = list(c.value).map((v, j) => {
        binds[`f${i}_${j}`] = bind(v);
        return `:f${i}_${j}`;
      });
      return `"${col}" IN (${names.join(', ')})`;
    }
    binds[`f${i}`] = bind(single(c.value));
    return `"${col}" ${SQL_OP[c.op]} :f${i}`;
  });
  return { sql: joinSql(parts, filter.combine), binds };
}

/** SQL string literal with quotes doubled (LanceDB / DataFusion). */
export function sqlLiteral(v: string | number | boolean): string {
  return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v);
}

/** LanceDB `where` clause: back-quoted columns, escaped literals. */
export function lanceWhere(filter: ExplorerFilter): string {
  const parts = filter.conditions.map((c) =>
    c.op === 'in' ? `\`${field(c.field)}\` IN (${list(c.value).map(sqlLiteral).join(', ')})` : `\`${field(c.field)}\` ${SQL_OP[c.op]} ${sqlLiteral(single(c.value))}`,
  );
  return joinSql(parts, filter.combine);
}

/** Milvus boolean expression with strings escaped and field names checked. */
export function milvusExpr(filter: ExplorerFilter): string {
  const lit = (v: FilterValue) => (typeof v === 'string' ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(v));
  const MOP: Record<Exclude<FilterOp, 'in'>, string> = { eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const parts = filter.conditions.map((c) => (c.op === 'in' ? `${field(c.field)} in [${list(c.value).map(lit).join(', ')}]` : `${field(c.field)} ${MOP[c.op]} ${lit(single(c.value))}`));
  return parts.length > 1 && filter.combine === 'or' ? `(${parts.join(' or ')})` : parts.join(filter.combine === 'or' ? ' or ' : ' and ');
}

/** Qdrant filter JSON: match / match-any / range; ≠ as a nested must_not; any-of as should. */
export function qdrantFilter(filter: ExplorerFilter): Record<string, unknown> | undefined {
  const RANGE_KEY: Record<string, string> = { gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' };
  const conds = filter.conditions.map((c) => {
    if (c.op === 'eq') return { key: c.field, match: { value: single(c.value) } };
    if (c.op === 'in') return { key: c.field, match: { any: list(c.value) } };
    if (c.op === 'ne') return { must_not: [{ key: c.field, match: { value: single(c.value) } }] };
    return { key: c.field, range: { [RANGE_KEY[c.op]]: single(c.value) } };
  });
  if (!conds.length) return undefined;
  return filter.combine === 'or' ? { should: conds } : { must: conds };
}

/** `{ field: { $op: value } }` conditions for Pinecone, Chroma and MongoDB. */
function opConditions(filter: ExplorerFilter): Array<Record<string, Record<string, unknown>>> {
  return filter.conditions.map((c) => ({ [field(c.field)]: { [`$${c.op}`]: c.op === 'in' ? list(c.value) : single(c.value) } }));
}
function combineOps(filter: ExplorerFilter): Record<string, unknown> | undefined {
  const c = opConditions(filter);
  return c.length === 0 ? undefined : c.length === 1 ? c[0] : { [filter.combine === 'or' ? '$or' : '$and']: c };
}

export const pineconeFilter = combineOps;
export const chromaWhere = combineOps;
/** MongoDB: field names cannot start an operator or reach into a sub-document. */
export const mongoFilter = (filter: ExplorerFilter): Record<string, unknown> => combineOps(filter) ?? {};

/** Elasticsearch clauses for `bool.filter`: term / match_phrase on text, range, terms; ≠ as must_not; any-of as one should. */
export function esFilter(filter: ExplorerFilter, fields: ExplorerField[]): Array<Record<string, unknown>> {
  const types = new Map(fields.map((f) => [f.name, f.type]));
  const eq = (name: string, v: FilterValue) => (types.get(name) === 'text' ? { match_phrase: { [name]: v } } : { term: { [name]: v } });
  const clauses = filter.conditions.map((c): Record<string, unknown> => {
    const name = field(c.field);
    if (c.op === 'eq') return eq(name, single(c.value));
    if (c.op === 'ne') return { bool: { must_not: [eq(name, single(c.value))] } };
    if (c.op === 'in') return types.get(name) === 'text' ? { bool: { should: list(c.value).map((v) => eq(name, v)), minimum_should_match: 1 } } : { terms: { [name]: list(c.value) } };
    return { range: { [name]: { [c.op]: single(c.value) } } };
  });
  return filter.combine === 'or' && clauses.length > 1 ? [{ bool: { should: clauses, minimum_should_match: 1 } }] : clauses;
}

/** Characters RediSearch treats as syntax inside a TAG value. */
const REDIS_TAG_SPECIAL = /[,.<>{}[\]"':;!@#$%^&*()\-+=~|/\\ ]/g;

/** RediSearch query syntax for TAG / NUMERIC / TEXT fields, escaped; ≠ as negation; any-of joined with |. */
export function redisFilter(filter: ExplorerFilter, fields: ExplorerField[]): string {
  const types = new Map(fields.map((f) => [f.name, f.type.toUpperCase()]));
  const tag = (s: FilterValue) => String(s).replace(REDIS_TAG_SPECIAL, (ch) => `\\${ch}`);
  const text = (s: FilterValue) => `"${String(s).replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
  const num = (v: FilterValue) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BadRequestException('Numeric filter values must be numbers.');
    return n;
  };
  const parts = filter.conditions.map((c) => {
    const name = field(c.field);
    const t = types.get(name);
    if (t === 'NUMERIC') {
      const v = single(c.value);
      const range: Record<string, string> = { eq: `[${num(v)} ${num(v)}]`, ne: `[${num(v)} ${num(v)}]`, gt: `[(${num(v)} +inf]`, gte: `[${num(v)} +inf]`, lt: `[-inf (${num(v)}]`, lte: `[-inf ${num(v)}]` };
      if (c.op === 'in') return `(${list(c.value).map((x) => `@${name}:[${num(x)} ${num(x)}]`).join('|')})`;
      return `${c.op === 'ne' ? '-' : ''}@${name}:${range[c.op]}`;
    }
    if (t === 'TEXT') {
      if (c.op === 'in') return `(${list(c.value).map((x) => `@${name}:${text(x)}`).join('|')})`;
      return `${c.op === 'ne' ? '-' : ''}@${name}:${text(single(c.value))}`;
    }
    if (c.op === 'in') return `@${name}:{${list(c.value).map(tag).join('|')}}`;
    return `${c.op === 'ne' ? '-' : ''}@${name}:{${tag(single(c.value))}}`;
  });
  if (filter.combine === 'or' && parts.length > 1) return `(${parts.map((p) => `(${p})`).join('|')})`;
  return parts.join(' ');
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
