import { ValueTransformer } from 'typeorm';

/** Postgres numeric / bigint come back as strings; keep them numbers (or null) in the application. */
export const numeric: ValueTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v === null || v === undefined ? null : Number(v)),
};
