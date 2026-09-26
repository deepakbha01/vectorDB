import { ExplorerCollectionInfo } from '../database-adapters/vector-explorer';

/**
 * Design vs deployed (Data Explorer overview): what the project's phases say
 * the collection should be, against what the target database reports. Pure.
 * A value either side does not know is "unknown", never a guessed match.
 */

export type CheckStatus = 'match' | 'mismatch' | 'info' | 'unknown';

export interface DesignCheck {
  key: 'collection' | 'dimension' | 'metric' | 'index' | 'fields' | 'volume';
  label: string;
  designed: string;
  actual: string;
  status: CheckStatus;
  /** The phase the designed value comes from. */
  source: string;
  note: string | null;
}

export interface DesignedCollection {
  /** Data & Embedding design; null when that phase has not run. */
  pipeline: { version: number; collectionName: string; dimension: number; metric: string; metadataFields: string[] } | null;
  /** Index Design decision (hnsw | ivf_flat | pq); null when that phase has not run. */
  index: { version: number; type: string } | null;
  /** Discovery's expected vector count; null when Discovery has not run. */
  discovery: { version: number; estimatedVectorCount: number } | null;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const METRIC_LABEL: Record<string, string> = { cosine: 'cosine', dot_product: 'dot product', euclidean: 'euclidean (L2)' };
const INDEX_LABEL: Record<string, string> = { hnsw: 'HNSW', ivf_flat: 'IVF-Flat', pq: 'PQ', managed: 'managed', other: 'other' };
const metricLabel = (m: string | null) => (m ? METRIC_LABEL[m] ?? m : '—');
/** One decimal; a handful of records against millions reads "under 0.1%", not "0%". */
const volumeShare = (n: number, of: number) => {
  const pct = (n / of) * 100;
  return pct > 0 && pct < 0.1 ? 'under 0.1%' : `${Math.round(pct * 10) / 10}%`;
};

export function compareDesign(viewing: string, info: ExplorerCollectionInfo, design: DesignedCollection): DesignCheck[] {
  const p = design.pipeline;
  const pipelineSource = p ? `Data & Embedding design v${p.version}` : 'Data & Embedding design (not run)';
  const checks: DesignCheck[] = [];

  // Collection: is this the one the design deploys?
  checks.push(
    !p
      ? { key: 'collection', label: 'Collection', designed: '—', actual: viewing, status: 'unknown', source: pipelineSource, note: 'No Data & Embedding design yet, so there is nothing to compare against.' }
      : p.collectionName === viewing
        ? { key: 'collection', label: 'Collection', designed: p.collectionName, actual: viewing, status: 'match', source: pipelineSource, note: null }
        : { key: 'collection', label: 'Collection', designed: p.collectionName, actual: viewing, status: 'info', source: pipelineSource, note: `You are viewing '${viewing}'; the design deploys '${p.collectionName}'. The checks below compare against the design anyway.` },
  );

  // Dimension.
  checks.push(
    !p || info.dimension === null
      ? { key: 'dimension', label: 'Vector dimension', designed: p ? String(p.dimension) : '—', actual: info.dimension === null ? '—' : String(info.dimension), status: 'unknown', source: pipelineSource, note: info.dimension === null ? 'The database did not report a dimension.' : null }
      : { key: 'dimension', label: 'Vector dimension', designed: String(p.dimension), actual: String(info.dimension), status: p.dimension === info.dimension ? 'match' : 'mismatch', source: pipelineSource, note: p.dimension === info.dimension ? null : 'Vectors from the designed embedding model will not fit this collection.' },
  );

  // Metric.
  checks.push(
    !p || info.metric === null
      ? { key: 'metric', label: 'Similarity metric', designed: p ? metricLabel(p.metric) : '—', actual: metricLabel(info.metric), status: 'unknown', source: pipelineSource, note: info.metric === null ? 'The database does not state a metric here (for pgvector it is set by the index).' : null }
      : { key: 'metric', label: 'Similarity metric', designed: metricLabel(p.metric), actual: metricLabel(info.metric), status: p.metric === info.metric ? 'match' : 'mismatch', source: pipelineSource, note: p.metric === info.metric ? null : 'Scores and ranking will differ from what the design assumed.' },
  );

  // Index type.
  const indexSource = design.index ? `Index Design v${design.index.version}` : 'Index Design (not run)';
  const built = [...new Set(info.indexes.map((i) => i.type))];
  const builtLabel = built.length ? built.map((t) => INDEX_LABEL[t] ?? t).join(', ') : 'none';
  checks.push(
    !design.index
      ? { key: 'index', label: 'ANN index', designed: '—', actual: builtLabel, status: 'unknown', source: indexSource, note: 'No Index Design yet.' }
      : built.includes('managed')
        ? { key: 'index', label: 'ANN index', designed: INDEX_LABEL[design.index.type] ?? design.index.type, actual: 'managed by the service', status: 'unknown', source: indexSource, note: 'The database chooses and tunes its own index, so there is no index type to compare.' }
      : !built.length
        ? { key: 'index', label: 'ANN index', designed: INDEX_LABEL[design.index.type] ?? design.index.type, actual: 'none', status: 'mismatch', source: indexSource, note: 'No ANN index is built: search is a full scan until it is.' }
        : { key: 'index', label: 'ANN index', designed: INDEX_LABEL[design.index.type] ?? design.index.type, actual: builtLabel, status: built.includes(design.index.type) ? 'match' : 'mismatch', source: indexSource, note: null },
  );

  // Metadata fields.
  if (!p) {
    checks.push({ key: 'fields', label: 'Metadata fields', designed: '—', actual: String(info.fields.length), status: 'unknown', source: pipelineSource, note: null });
  } else {
    const actual = new Set(info.fields.map((f) => f.name));
    const missing = p.metadataFields.filter((f) => !actual.has(f));
    const extra = [...actual].filter((f) => !p.metadataFields.includes(f));
    checks.push({
      key: 'fields',
      label: 'Metadata fields',
      designed: p.metadataFields.join(', ') || 'none',
      actual: [...actual].join(', ') || 'none',
      status: missing.length ? 'mismatch' : 'match',
      source: pipelineSource,
      note: [missing.length ? `Missing: ${missing.join(', ')}.` : null, extra.length ? `Not in the design: ${extra.join(', ')}.` : null].filter(Boolean).join(' ') || null,
    });
  }

  // Volume: how much of the expected corpus is loaded - informational, never a pass / fail.
  const d = design.discovery;
  checks.push(
    !d || info.recordCount === null
      ? { key: 'volume', label: 'Records loaded', designed: d ? fmt(d.estimatedVectorCount) : '—', actual: info.recordCount === null ? '—' : fmt(info.recordCount), status: 'unknown', source: d ? `Discovery v${d.version}` : 'Discovery (not run)', note: null }
      : {
          key: 'volume',
          label: 'Records loaded',
          designed: fmt(d.estimatedVectorCount),
          actual: `${info.countIsEstimate ? '≈ ' : ''}${fmt(info.recordCount)}`,
          status: 'info',
          source: `Discovery v${d.version}`,
          note: d.estimatedVectorCount > 0 ? `${volumeShare(info.recordCount, d.estimatedVectorCount)} of the expected volume.` : null,
        },
  );
  return checks;
}
