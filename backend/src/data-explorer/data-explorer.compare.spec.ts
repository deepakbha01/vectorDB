import { compareDesign, DesignedCollection } from './data-explorer.compare';
import { ExplorerCollectionInfo } from '../database-adapters/vector-explorer';
import { DOCUMENTS_READ } from './data-explorer-read-audit.interceptor';

const info = (o: Partial<ExplorerCollectionInfo> = {}): ExplorerCollectionInfo => ({
  name: 'docs',
  recordCount: 250_000,
  countIsEstimate: false,
  dimension: 1536,
  metric: 'cosine',
  indexes: [{ type: 'hnsw', detail: 'hnsw (m=16)' }],
  fields: [{ name: 'department', type: 'text' }, { name: 'source', type: 'text' }],
  notes: [],
  ...o,
});
const design = (o: Partial<DesignedCollection> = {}): DesignedCollection => ({
  pipeline: { version: 2, collectionName: 'docs', dimension: 1536, metric: 'cosine', metadataFields: ['department', 'source'] },
  index: { version: 1, type: 'hnsw' },
  discovery: { version: 3, estimatedVectorCount: 1_000_000 },
  ...o,
});
const byKey = (checks: ReturnType<typeof compareDesign>) => Object.fromEntries(checks.map((c) => [c.key, c]));

describe('compareDesign - design vs deployed', () => {
  it('matches a collection deployed exactly as designed, and reports volume as information', () => {
    const c = byKey(compareDesign('docs', info(), design()));
    expect(['collection', 'dimension', 'metric', 'index', 'fields'].map((k) => c[k].status)).toEqual(['match', 'match', 'match', 'match', 'match']);
    expect(c.volume).toEqual(expect.objectContaining({ status: 'info', designed: '1,000,000', actual: '250,000', note: '25% of the expected volume.' }));
    expect(c.dimension.source).toBe('Data & Embedding design v2');
  });

  it('flags a wrong dimension, metric, index and missing fields', () => {
    const c = byKey(compareDesign('docs', info({ dimension: 768, metric: 'euclidean', indexes: [{ type: 'ivf_flat', detail: '' }], fields: [{ name: 'department', type: 'text' }, { name: 'owner', type: 'text' }] }), design()));
    expect([c.dimension.status, c.metric.status, c.index.status, c.fields.status]).toEqual(['mismatch', 'mismatch', 'mismatch', 'mismatch']);
    expect(c.fields.note).toBe('Missing: source. Not in the design: owner.');
  });

  it('calls a missing ANN index a mismatch - search would be a full scan', () => {
    expect(byKey(compareDesign('docs', info({ indexes: [] }), design())).index).toEqual(expect.objectContaining({ status: 'mismatch', actual: 'none' }));
  });

  it('never guesses: unknown when a phase has not run or the database does not say', () => {
    const c = byKey(compareDesign('docs', info({ metric: null, dimension: null, recordCount: null }), design({ pipeline: null, index: null, discovery: null })));
    expect(Object.values(c).map((x) => x.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  });

  it('says so when the viewed collection is not the designed one', () => {
    expect(byKey(compareDesign('scratch', info({ name: 'scratch' }), design())).collection).toEqual(expect.objectContaining({ status: 'info', designed: 'docs', actual: 'scratch' }));
  });

  it('treats an index the service manages (Pinecone) as unknown, not a mismatch', () => {
    expect(byKey(compareDesign('docs', info({ indexes: [{ type: 'managed', detail: '' }] }), design())).index).toEqual(expect.objectContaining({ status: 'unknown', actual: 'managed by the service' }));
  });

  it('shows a tiny share as under 0.1%, not 0%', () => {
    expect(byKey(compareDesign('docs', info({ recordCount: 3 }), design())).volume.note).toBe('under 0.1% of the expected volume.');
  });

  it('marks an estimated count', () => {
    expect(byKey(compareDesign('docs', info({ recordCount: 5_000_000, countIsEstimate: true }), design())).volume.actual).toBe('≈ 5,000,000');
  });
});

describe('document-read audit match', () => {
  it('matches the documents list, not a collection that happens to be called "documents"', () => {
    expect(DOCUMENTS_READ.test('/api/projects/p/data-explorer/collections/docs/documents?limit=25')).toBe(true);
    expect(DOCUMENTS_READ.test('/api/projects/p/data-explorer/collections/documents')).toBe(false);
    expect(DOCUMENTS_READ.test('/api/projects/p/data-explorer/collections/documents/documents')).toBe(true);
  });
});
