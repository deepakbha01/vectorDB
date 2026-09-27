import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useFeatures } from '../api/features';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckStatus, VectorKind, ConnectionTestResult, ConnectionView, ExplorerCollections, ExplorerCompareResult, ExplorerDocuments, ExplorerMap, ExplorerOverview, ExplorerRecordDetail, ExplorerSearchResult, ExplorerStatus } from '../api/dataExplorer';
import { SCATTER, useChart } from '../components/token/charts';
import { useTheme } from '../theme';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

type View = 'overview' | 'documents' | 'search' | 'compare' | 'map';

/** The vector space chosen in the collection bar ('' = the collection's default). */
type VectorSpaceChoice = { name: string; kind: VectorKind; dimension: number | null };
type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
type FilterRow = { field: string; op: FilterOp; value: string };
type FilterState = { combine: 'and' | 'or'; rows: FilterRow[] };

/** Status words go with every colour (a check is never colour alone). */
const STATUS: Record<CheckStatus, { icon: string; label: string; color: string }> = {
  match: { icon: '✓', label: 'Match', color: 'var(--success)' },
  mismatch: { icon: '▲', label: 'Mismatch', color: 'var(--danger)' },
  info: { icon: '●', label: 'Info', color: 'var(--primary-text)' },
  unknown: { icon: '—', label: 'Unknown', color: 'var(--muted)' },
};
const METRIC: Record<string, string> = { cosine: 'Cosine', dot_product: 'Dot product', euclidean: 'Euclidean (L2)' };
const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString());
const cell = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Data Explorer (phase 1): a read-only look inside the project's target
 * vector database, compared against the project's own design. Nothing here
 * writes to, loads or changes the database.
 */
export function DataExplorerPage() {
  const { id } = useParams<{ id: string }>();
  const features = useFeatures();
  const { user } = useAuth();
  const canRead = user?.role === 'admin' || user?.role === 'architect';
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<ExplorerStatus | null>(null);
  const [collections, setCollections] = useState<ExplorerCollections | null>(null);
  const [collection, setCollection] = useState<string>('');
  const [view, setView] = useState<View>('overview');
  const [overview, setOverview] = useState<ExplorerOverview | null>(null);
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const [vectorName, setVectorName] = useState('');
  const [partition, setPartition] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [reload, setReload] = useState(0);
  const base = `/projects/${id}/data-explorer`;

  useEffect(() => {
    if (!id) return;
    setError(null);
    setCollections(null);
    apiClient.get<Project>(`/projects/${id}`).then((r) => setProject(r.data));
    apiClient
      .get<ExplorerStatus>(`${base}/status`)
      .then(async (r) => {
        setStatus(r.data);
        if (!r.data.supported || !r.data.connected) return;
        const c = await apiClient.get<ExplorerCollections>(`${base}/collections`);
        setCollections(c.data);
        setCollection(c.data.collections.find((x) => x.designed)?.name ?? c.data.collections[0]?.name ?? '');
      })
      .catch((e) => setError(extractErrorMessage(e, 'Could not reach the Data Explorer.')));
  }, [id, base, reload]);

  useEffect(() => {
    setOpenRecord(null);
    setVectorName('');
    setPartition('');
  }, [collection]);

  useEffect(() => {
    if (!collection) return;
    setOverview(null);
    apiClient
      .get<ExplorerOverview>(`${base}/collections/${encodeURIComponent(collection)}${partition ? `?partition=${encodeURIComponent(partition)}` : ''}`)
      .then((r) => {
        setOverview(r.data);
        // A multi-tenant collection is read one tenant at a time: start with the first.
        const p = r.data.info.partitions;
        if (p?.required && !partition && p.names.length) setPartition(p.names[0]);
      })
      .catch((e) => setError(extractErrorMessage(e, 'Could not describe the collection.')));
  }, [collection, base, partition]);

  const space: VectorSpaceChoice = (() => {
    const spaces = overview?.info.vectors;
    if (!spaces?.length) return { name: '', kind: 'dense', dimension: overview?.info.dimension ?? null };
    const chosen = vectorName ? spaces.find((v) => v.name === vectorName) : spaces[0];
    return { name: vectorName, kind: chosen?.kind ?? 'dense', dimension: chosen?.dimension ?? null };
  })();

  if (!project) return <div className="main-content">Loading...</div>;

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content" style={{ maxWidth: 1250 }}>
        <TopBar title="Data Explorer" />
        {!features.dataExplorer && !status ? (
          <div className="card">The Data Explorer is not enabled on this server (<code>DATA_EXPLORER_ENABLED</code>).</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, maxWidth: 1000 }}>
              A read-only look inside this project's target vector database{status ? ` (${status.platform})` : ''}, checked against the project's own{' '}
              <Link to={`/projects/${project.id}/data-pipeline`}>Data &amp; Embedding design</Link>, <Link to={`/projects/${project.id}/index-design`}>Index Design</Link> and{' '}
              <Link to={`/projects/${project.id}/discovery`}>Discovery</Link>. Nothing here writes to, loads or changes the database.
            </p>
            {error && <div className="card error-text">{error}</div>}
            {status && status.platform !== 'undetermined' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                Connection:
                <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                  {status.connectionSource === 'project' ? "This project's own settings" : 'Server settings (TARGET_*)'}
                </span>
                <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setShowConnection((s) => !s)} aria-expanded={showConnection}>
                  {showConnection ? 'Hide connection' : canRead ? 'Manage connection' : 'View connection'}
                </button>
              </div>
            )}
            {showConnection && id && <ConnectionPanel projectId={id} canEdit={canRead} onChanged={() => setReload((n) => n + 1)} />}
            {status && (!status.supported || !status.connected) && (
              <div className="card" style={{ borderLeft: '4px solid var(--warning)' }}>
                <strong>{status.supported ? 'The target database is not reachable.' : 'Not available for this project yet.'}</strong>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{status.message}</div>
              </div>
            )}
            {collections && (
              <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderLeft: '4px solid var(--primary-text)' }}>
                <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
                  Collection
                  <select value={collection} onChange={(e) => setCollection(e.target.value)} style={{ fontSize: 13, padding: '4px 6px' }}>
                    {collections.collections.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                        {c.designed ? ' (designed)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {overview?.info.vectors && overview.info.vectors.length > 0 && (
                  <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
                    Vector
                    <select value={vectorName} onChange={(e) => setVectorName(e.target.value)} style={{ fontSize: 13, padding: '4px 6px' }}>
                      {overview.info.vectors.map((v, i) => (
                        <option key={v.name} value={i === 0 ? '' : v.name}>
                          {v.name || '(unnamed)'} ({v.kind ?? 'dense'}
                          {v.dimension ? `, ${v.dimension}${v.kind === 'binary' ? ' bits' : '-d'}` : ''}
                          {v.metric ? `, ${v.metric}` : ''})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {overview?.info.partitions && (
                  <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {overview.info.partitions.kind === 'tenant' ? 'Tenant' : 'Namespace'}
                    <select value={partition} onChange={(e) => setPartition(e.target.value)} style={{ fontSize: 13, padding: '4px 6px' }}>
                      {!overview.info.partitions.required && <option value="">(default namespace)</option>}
                      {overview.info.partitions.names.map((n) => (
                        <option key={n} value={n}>
                          {n}
                          {overview.info.partitions?.counts?.[n] !== undefined ? ` (${overview.info.partitions.counts[n].toLocaleString()})` : ''}
                        </option>
                      ))}
                    </select>
                    {overview.info.partitions.truncated && <span style={{ color: 'var(--muted)' }}>first {overview.info.partitions.names.length} listed</span>}
                  </label>
                )}
                {!collections.collections.length && <span style={{ fontSize: 13, color: 'var(--muted)' }}>The database has no vector collections yet.</span>}
                {collections.designedCollection && !collections.collections.some((c) => c.designed) && (
                  <span style={{ fontSize: 13, color: 'var(--warning)' }}>▲ The designed collection '{collections.designedCollection}' is not deployed.</span>
                )}
                <span style={{ flex: 1 }} />
                <div role="tablist" aria-label="View" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                  {(['overview', 'documents', 'search', 'compare', 'map'] as View[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      onClick={() => setView(v)}
                      style={{ padding: '6px 14px', border: 'none', fontSize: 13, background: view === v ? 'var(--primary-strong)' : 'var(--surface-2)', color: view === v ? '#fff' : 'var(--text)' }}
                    >
                      {({ overview: 'Overview', documents: 'Documents', search: 'Search', compare: 'Compare', map: 'Map' } as Record<View, string>)[v]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {collection && view === 'overview' && <OverviewView overview={overview} />}
            {collection && view !== 'overview' && !canRead && (
              <div className="card" style={{ fontSize: 13 }}>
                Record contents are shown to admins and architects only.
              </div>
            )}
            {collection && view === 'documents' && canRead && overview && <DocumentsView key={collection} base={base} collection={collection} fields={overview.info.fields.map((f) => f.name)} sortable={!!overview.capabilities?.sort} partition={partition} onOpen={setOpenRecord} />}
            {collection && view === 'search' && canRead && overview && <SearchView key={collection} base={base} collection={collection} fields={overview.info.fields.map((f) => f.name)} keyword={overview.capabilities?.keyword ?? { supported: false, ranking: null }} nativeHybrid={overview.capabilities?.nativeHybrid ?? { supported: false, ranking: null }} space={space} partition={partition} onOpen={setOpenRecord} />}
            {collection && openRecord && canRead && (view === 'documents' || view === 'search') && <RecordPanel base={base} collection={collection} id={openRecord} vectorName={vectorName} partition={partition} onClose={() => setOpenRecord(null)} />}
            {collection && view === 'compare' && canRead && overview && <CompareView key={collection} base={base} collection={collection} fields={overview.info.fields.map((f) => f.name)} keyword={overview.capabilities?.keyword ?? { supported: false, ranking: null }} nativeHybrid={!!overview.capabilities?.nativeHybrid?.supported} vectorName={vectorName} vectorKind={space.kind} partition={partition} />}
            {collection && view === 'map' && canRead && overview && <MapView key={collection} base={base} collection={collection} fields={overview.info.fields.map((f) => f.name)} vectorName={vectorName} vectorKind={space.kind} partition={partition} />}
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewView({ overview }: { overview: ExplorerOverview | null }) {
  if (!overview) return <div className="card">Loading…</div>;
  const { info, checks } = overview;
  const cards: Array<[string, string, string?]> = [
    ['Records', `${info.countIsEstimate ? '≈ ' : ''}${fmt(info.recordCount)}`, info.countIsEstimate ? 'estimate from table statistics' : undefined],
    ['Dimension', fmt(info.dimension)],
    ['Metric', info.metric ? METRIC[info.metric] ?? info.metric : '—'],
    ['ANN index', info.indexes.length ? info.indexes.map((i) => i.type.toUpperCase().replace('_', '-')).join(', ') : 'none'],
  ];
  const mismatches = checks.filter((c) => c.status === 'mismatch').length;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {cards.map(([label, value, sub]) => (
          <div className="card" key={label}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 22 }}>
              {value}
            </div>
            {sub && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</div>}
          </div>
        ))}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="metric-label">
          Design vs deployed - {mismatches ? `${mismatches} mismatch${mismatches === 1 ? '' : 'es'}` : 'no mismatches'}
        </div>
        <Table
          headers={['Check', 'Designed', 'In the database', 'Result', 'Source']}
          rows={checks.map((c) => [
            <span key="l">
              {c.label}
              {c.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{c.note}</div>}
            </span>,
            c.designed,
            c.actual,
            <span key="s" style={{ color: STATUS[c.status].color, whiteSpace: 'nowrap', fontWeight: 600 }}>
              {STATUS[c.status].icon} {STATUS[c.status].label}
            </span>,
            <span key="src" style={{ fontSize: 12, color: 'var(--muted)' }}>{c.source}</span>,
          ])}
        />
      </div>
      <div className="card">
        <div className="metric-label">Fields and indexes</div>
        <div style={{ fontSize: 13 }}>
          <div>
            <strong>Metadata fields:</strong> {info.fields.map((f) => `${f.name} (${f.type})`).join(', ') || 'none'}
          </div>
          {info.indexes.map((i) => (
            <div key={i.detail} style={{ marginTop: 6 }}>
              <strong>Index:</strong> <code>{i.detail}</code>
            </div>
          ))}
          {info.notes.map((n) => (
            <div key={n} style={{ marginTop: 6, color: 'var(--muted)' }}>
              {n}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const OPS: Array<[FilterOp, string]> = [
  ['eq', '='],
  ['ne', '≠'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['in', 'in'],
];
const NO_FILTERS: FilterState = { combine: 'and', rows: [] };

/**
 * Up to five conditions (= ≠ > ≥ < ≤, or "in" a comma-separated list), all of
 * which must hold or any of which may. Fields come from the collection itself;
 * the server checks each field's type (ranges need a number).
 */
function FilterEditor({ fields, value, onChange }: { fields: string[]; value: FilterState; onChange: (v: FilterState) => void }) {
  const { rows } = value;
  const setRows = (next: FilterRow[]) => onChange({ ...value, rows: next });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.length > 1 && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          Match
          <select aria-label="Combine filters" value={value.combine} onChange={(e) => onChange({ ...value, combine: e.target.value as 'and' | 'or' })} style={{ fontSize: 13, padding: '4px 6px' }}>
            <option value="and">all of these</option>
            <option value="or">any of these</option>
          </select>
        </label>
      )}
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <select aria-label="Filter field" value={r.field} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} style={{ fontSize: 13, padding: '4px 6px' }}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select aria-label="Filter operator" value={r.op} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)))} style={{ fontSize: 13, padding: '4px 6px' }}>
            {OPS.map(([op, label]) => (
              <option key={op} value={op}>
                {label}
              </option>
            ))}
          </select>
          <input
            aria-label="Filter value"
            value={r.value}
            placeholder={r.op === 'in' ? 'a, b, c' : ''}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            style={{ fontSize: 13, padding: '4px 6px', width: 200 }}
          />
          <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 12 }}>
            Remove
          </button>
        </div>
      ))}
      {fields.length > 0 && rows.length < 5 && (
        <button type="button" onClick={() => setRows([...rows, { field: fields[0], op: 'eq', value: '' }])} style={{ alignSelf: 'start', background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 12, padding: 0 }}>
          + Add a filter
        </button>
      )}
    </div>
  );
}
/** The structured filter the API takes, or undefined when no condition is complete. */
const toFilter = (f: FilterState) => {
  const conditions = f.rows.filter((r) => r.field && r.value.trim() !== '').map((r) => ({ field: r.field, op: r.op, value: r.value }));
  return conditions.length ? { combine: f.combine, conditions } : undefined;
};

type SortRow = { field: string; direction: 'asc' | 'desc' };
const MAX_SORT = 3;

function DocumentsView({ base, collection, fields, sortable, partition, onOpen }: { base: string; collection: string; fields: string[]; sortable: boolean; partition: string; onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [applied, setApplied] = useState<ReturnType<typeof toFilter>>(undefined);
  const [sort, setSort] = useState<SortRow[]>([]);
  // Cursors of the pages visited, so Previous can go back.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState<ExplorerDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  const sortParam = sort.filter((s) => s.field).map((s) => `${s.field}:${s.direction}`).join(',');

  useEffect(() => {
    setCursors([null]);
  }, [partition]);

  useEffect(() => {
    setError(null);
    const params = new URLSearchParams({ limit: '25' });
    if (cursor) params.set('cursor', cursor);
    if (applied) params.set('filter', JSON.stringify(applied));
    if (sortParam) params.set('sort', sortParam);
    if (partition) params.set('partition', partition);
    apiClient
      .get<ExplorerDocuments>(`${base}/collections/${encodeURIComponent(collection)}/documents?${params}`)
      .then((r) => setPage(r.data))
      .catch((e) => setError(extractErrorMessage(e, 'Could not read records.')));
  }, [base, collection, cursor, applied, sortParam, partition]);

  const setRow = (i: number, row: SortRow | null) => {
    setSort(row ? sort.map((s, j) => (j === i ? row : s)) : sort.filter((_, j) => j !== i));
    setCursors([null]);
  };
  const cols = page ? [...new Set(page.rows.flatMap((r) => Object.keys(r.metadata)))] : [];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowX: 'auto' }}>
      <div className="metric-label">Records - 25 per page, long values shortened; this read is audited</div>
      <FilterEditor fields={fields} value={filters} onChange={setFilters} />
      <div>
        <button
          type="button"
          className="secondary-btn"
          style={{ padding: '6px 12px', fontSize: 13 }}
          onClick={() => {
            setApplied(toFilter(filters));
            setCursors([null]);
          }}
        >
          Apply filters
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        {sortable ? (
          <>
            {sort.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ width: 64, color: 'var(--muted)' }}>{i === 0 ? 'Sort by' : 'then by'}</span>
                <select aria-label={`Sort field ${i + 1}`} value={s.field} onChange={(e) => setRow(i, { ...s, field: e.target.value })} style={{ fontSize: 13, padding: '4px 6px' }}>
                  {fields
                    .filter((f) => f === s.field || !sort.some((x) => x.field === f))
                    .map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                </select>
                <select aria-label={`Sort direction ${i + 1}`} value={s.direction} onChange={(e) => setRow(i, { ...s, direction: e.target.value as 'asc' | 'desc' })} style={{ fontSize: 13, padding: '4px 6px' }}>
                  <option value="asc">ascending</option>
                  <option value="desc">descending</option>
                </select>
                <button type="button" aria-label={`Remove sort field ${i + 1}`} onClick={() => setRow(i, null)} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 13 }}>
                  Remove
                </button>
              </div>
            ))}
            {sort.length < MAX_SORT && fields.some((f) => !sort.some((x) => x.field === f)) && (
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setSort([...sort, { field: fields.find((f) => !sort.some((x) => x.field === f))!, direction: 'asc' }]);
                    setCursors([null]);
                  }}
                  style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 13, padding: 0 }}
                >
                  + {sort.length ? 'Then sort by another field' : 'Sort by a field'}
                </button>
                {!sort.length && <span style={{ color: 'var(--muted)' }}> (otherwise the database's own order)</span>}
              </div>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--muted)' }}>This database lists records in its own order; sorting is not available.</span>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      {page && (
        <>
          <Table headers={['ID', ...cols, 'Vector']} rows={page.rows.map((r) => [<IdButton key="id" id={r.id} onOpen={onOpen} />, ...cols.map((c) => cell(r.metadata[c])), <span key="v" style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{r.vectorPreview ? `[${r.vectorPreview.join(', ')}${(r.dimension ?? 0) > r.vectorPreview.length ? ', …' : ''}] · ${r.dimension}d` : '—'}</span>])} />
          {!page.rows.length && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No records match.</div>}
          <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
            {cursors.length > 1 && (
              <button type="button" onClick={() => setCursors(cursors.slice(0, -1))} style={{ background: 'none', border: 'none', color: 'var(--primary-text)' }}>
                ← Previous
              </button>
            )}
            {page.nextCursor && (
              <button type="button" onClick={() => setCursors([...cursors, page.nextCursor])} style={{ background: 'none', border: 'none', color: 'var(--primary-text)' }}>
                Next →
              </button>
            )}
            <span style={{ color: 'var(--muted)' }}>Page {cursors.length}</span>
          </div>
        </>
      )}
    </div>
  );
}

type SearchMode = 'dense' | 'keyword' | 'hybrid';
type Fusion = 'rrf' | 'weighted' | 'native';

/** "3:0.5, 17:1.2" or {"indices": [3, 17], "values": [0.5, 1.2]} → a sparse vector; null if neither. */
function parseSparse(raw: string): { indices: number[]; values: number[] } | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { indices?: unknown; values?: unknown };
      return Array.isArray(o.indices) && Array.isArray(o.values) ? { indices: o.indices.map(Number), values: o.values.map(Number) } : null;
    } catch {
      return null;
    }
  }
  const pairs = t.split(/[\s,]+/).filter(Boolean).map((p) => p.split(':'));
  if (pairs.some((p) => p.length !== 2 || !/^\d+$/.test(p[0]) || !Number.isFinite(Number(p[1])))) return null;
  return { indices: pairs.map((p) => Number(p[0])), values: pairs.map((p) => Number(p[1])) };
}

/** A bit string ("0110…", spaces ignored) or a JSON array of 0/1 → bits; null if neither. */
function parseBits(raw: string): number[] | null {
  const t = raw.replace(/\s+/g, '');
  if (/^[01]+$/.test(t)) return Array.from(t, (c) => (c === '1' ? 1 : 0));
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) && a.every((x) => x === 0 || x === 1) ? (a as number[]) : null;
  } catch {
    return null;
  }
}

/**
 * Dense (text embedded with the project's model, or a raw vector), keyword
 * (ranked by the database) or hybrid (both, fused here by rank or score, or by
 * the database itself). A sparse or binary vector space takes its own query.
 */
function SearchView({ base, collection, fields, keyword, nativeHybrid, space, partition, onOpen }: { base: string; collection: string; fields: string[]; keyword: { supported: boolean; ranking: string | null }; nativeHybrid: { supported: boolean; ranking: string | null }; space: VectorSpaceChoice; partition: string; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<SearchMode>('dense');
  const [input, setInput] = useState<'text' | 'vector'>('text');
  const [alpha, setAlpha] = useState(0.5);
  const [fusion, setFusion] = useState<Fusion>('rrf');
  const [minScore, setMinScore] = useState('');
  const [text, setText] = useState('');
  const [vectorText, setVectorText] = useState('');
  const [topK, setTopK] = useState(10);
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [result, setResult] = useState<ExplorerSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dense = space.kind === 'dense';
  const effectiveMode: SearchMode = dense ? mode : 'dense';
  const usesVector = !dense || (mode === 'dense' && input === 'vector');
  const native = effectiveMode === 'hybrid' && fusion === 'native';

  const run = async () => {
    setError(null);
    const body: Record<string, unknown> = { mode: effectiveMode, topK, filter: toFilter(filters) };
    if (space.kind === 'sparse') {
      const s = parseSparse(vectorText);
      if (!s) return setError('Give the sparse vector as index:weight pairs (e.g. 3:0.5, 17:1.2) or {"indices": [...], "values": [...]}.');
      body.sparse = s;
    } else if (space.kind === 'binary') {
      const b = parseBits(vectorText);
      if (!b) return setError('Give the binary vector as bits, e.g. 0110 1001, or a JSON array of 0 and 1.');
      body.vector = b;
    } else if (usesVector) {
      try {
        const v = JSON.parse(vectorText);
        if (!Array.isArray(v)) throw new Error();
        body.vector = v;
      } catch {
        return setError('The vector must be a JSON array of numbers, e.g. [0.12, -0.4, …].');
      }
    } else body.text = text;
    if (effectiveMode === 'hybrid') Object.assign(body, { alpha, fusion });
    if (minScore.trim() && !native) {
      const m = Number(minScore);
      if (!Number.isFinite(m)) return setError('The minimum score must be a number.');
      body.minScore = m;
    }
    if (space.name && effectiveMode !== 'keyword') body.vectorName = space.name;
    if (partition) body.partition = partition;
    setBusy(true);
    try {
      const { data } = await apiClient.post<ExplorerSearchResult>(`${base}/collections/${encodeURIComponent(collection)}/search`, body);
      setResult(data);
    } catch (e) {
      setError(extractErrorMessage(e, 'The search failed.'));
    } finally {
      setBusy(false);
    }
  };

  const hybrid = result?.mode === 'hybrid';
  const nativeResult = result?.fusion === 'native';
  const cols = result ? [...new Set(result.results.flatMap((r) => Object.keys(r.metadata)))] : [];
  const MODES: Array<[SearchMode, string]> = [
    ['dense', space.kind === 'dense' ? 'Dense (vector)' : `${space.kind === 'sparse' ? 'Sparse' : 'Binary'} vector`],
    ['keyword', 'Keyword'],
    ['hybrid', 'Hybrid'],
  ];
  const FUSIONS: Array<[Fusion, string, boolean]> = [
    ['rrf', 'Rank fusion (RRF)', true],
    ['weighted', 'Weighted scores', true],
    ['native', "The database's own", nativeHybrid.supported],
  ];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowX: 'auto' }}>
      <div className="metric-label">Search - dense embeds text with the project's model, as ingestion does; keyword is ranked by the database</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap', alignItems: 'center' }}>
        {MODES.map(([m, label]) => {
          const off = m !== 'dense' && (!keyword.supported || !dense);
          return (
            <label key={m} style={{ display: 'flex', gap: 6, alignItems: 'center', color: off ? 'var(--muted)' : undefined }}>
              <input type="radio" checked={effectiveMode === m} disabled={off} onChange={() => setMode(m)} /> {label}
            </label>
          );
        })}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Top K
          <input type="number" min={1} max={50} value={topK} onChange={(e) => setTopK(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 70, fontSize: 13, padding: '4px 6px' }} />
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: native ? 'var(--muted)' : undefined }} title={native ? "Not available with the database's own hybrid ranking" : undefined}>
          Min score
          <input type="number" step="any" value={minScore} disabled={native} onChange={(e) => setMinScore(e.target.value)} placeholder="none" aria-label="Minimum score" style={{ width: 90, fontSize: 13, padding: '4px 6px' }} />
        </label>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {!dense
          ? `'${space.name}' is a ${space.kind} vector: search it with a ${space.kind} query. Keyword and hybrid search use the dense vector.`
          : keyword.supported
            ? `Keyword ranking: ${keyword.ranking}.`
            : 'This database does not rank keyword search here, so only dense search is available.'}
        {minScore.trim() && !native ? ` The minimum score applies to ${effectiveMode === 'hybrid' ? 'the dense candidates, before fusion' : `the ${effectiveMode} scores`}.` : ''}
      </div>
      {dense && mode === 'dense' && (
        <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={input === 'text'} onChange={() => setInput('text')} /> Text
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={input === 'vector'} onChange={() => setInput('vector')} /> Vector (JSON array)
          </label>
        </div>
      )}
      {effectiveMode === 'hybrid' && (
        <>
          <div role="radiogroup" aria-label="Fusion" style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
            {FUSIONS.map(([f, label, ok]) => (
              <label key={f} style={{ display: 'flex', gap: 6, alignItems: 'center', color: ok ? undefined : 'var(--muted)' }}>
                <input type="radio" checked={fusion === f} disabled={!ok} onChange={() => setFusion(f)} /> {label}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {fusion === 'rrf'
              ? 'Fuses by rank: robust to the two lists scoring on different scales.'
              : fusion === 'weighted'
                ? "Rescales each list's scores to 0-1 and adds them by weight: keeps score gaps, so an outlier can dominate."
                : (nativeHybrid.ranking ?? 'Fused by the database itself.')}
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
            Keyword
            <input type="range" min={0} max={1} step={0.1} value={alpha} onChange={(e) => setAlpha(Number(e.target.value))} aria-label="Dense weight" style={{ width: 220 }} />
            Dense
            <span style={{ color: 'var(--muted)' }}>
              {Math.round(alpha * 100)}% dense / {Math.round((1 - alpha) * 100)}% keyword
            </span>
          </label>
        </>
      )}
      {space.kind === 'sparse' ? (
        <textarea aria-label="Sparse query vector" value={vectorText} onChange={(e) => setVectorText(e.target.value)} rows={3} placeholder='index:weight pairs, e.g. 3:0.5, 17:1.2 - or {"indices": [3, 17], "values": [0.5, 1.2]}' style={{ fontSize: 13, padding: 8, fontFamily: 'var(--font-mono)' }} />
      ) : space.kind === 'binary' ? (
        <textarea aria-label="Binary query vector" value={vectorText} onChange={(e) => setVectorText(e.target.value)} rows={3} placeholder={`${space.dimension ?? ''} bits, e.g. 0110 1001 …`} style={{ fontSize: 13, padding: 8, fontFamily: 'var(--font-mono)' }} />
      ) : usesVector ? (
        <textarea aria-label="Search vector" value={vectorText} onChange={(e) => setVectorText(e.target.value)} rows={3} placeholder="[0.12, -0.4, …]" style={{ fontSize: 13, padding: 8, fontFamily: 'var(--font-mono)' }} />
      ) : (
        <textarea aria-label="Search text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder="e.g. termination clause for contractors" style={{ fontSize: 14, padding: 8 }} />
      )}
      <FilterEditor fields={fields} value={filters} onChange={setFilters} />
      <div>
        <button type="button" className="primary-btn" disabled={busy || (usesVector ? !vectorText.trim() : !text.trim())} onClick={run}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {result && (
        <>
          <div style={{ fontSize: 13 }}>
            <strong>{result.latencyMs} ms</strong>
            {result.targetP95LatencyMs !== null && (
              <span style={{ color: result.withinTarget ? 'var(--success)' : 'var(--warning)' }}>
                {' '}
                {result.withinTarget ? '✓ within' : '▲ over'} the {result.targetP95LatencyMs} ms P95 target
              </span>
            )}
            {result.embedding && (
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · embedded with {result.embedding.providerId} / {result.embedding.modelId}
                {result.embedding.live ? '' : ' (offline stand-in)'}
              </span>
            )}
            {result.candidates && (
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · candidates: {result.candidates.dense} dense, {result.candidates.keyword} keyword
              </span>
            )}
            {result.threshold && (
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · min score {result.threshold.minScore}: {result.threshold.removed} dropped
              </span>
            )}
          </div>
          <StatsLine stats={result.stats} />
          <QueryStatsLine stats={result.queryStats} />
          <Table
            headers={['#', 'ID', hybrid ? (nativeResult ? 'Database score' : 'Fused score') : result.mode === 'keyword' ? 'Keyword score' : 'Score', ...(hybrid && !nativeResult ? ['Dense rank', 'Keyword rank'] : []), ...cols]}
            rows={result.results.map((r, i) => [
              String(i + 1),
              <IdButton key="id" id={r.id} onOpen={onOpen} />,
              hybrid ? r.score.toFixed(5) : r.score.toFixed(4),
              ...(hybrid && !nativeResult ? [r.denseRank ?? '—', r.keywordRank ?? '—'].map(String) : []),
              ...cols.map((c) => cell(r.metadata[c])),
            ])}
          />
          {!result.results.length && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No matches.</div>}
          {result.notes.map((n) => (
            <div key={n} style={{ fontSize: 12, color: 'var(--muted)' }}>
              {n}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** The query vector itself: an unusual norm or many zeros explains odd scores. */
function QueryStatsLine({ stats }: { stats?: ExplorerSearchResult['queryStats'] }) {
  if (!stats) return null;
  const f = (n: number) => (Math.abs(n) >= 1000 || (n !== 0 && Math.abs(n) < 0.001) ? n.toExponential(2) : String(Math.round(n * 10000) / 10000));
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
      query:{' '}
      {stats.kind === 'dense'
        ? `${stats.dimension}-d · norm ${f(stats.norm)}${stats.normalised ? ' (unit length)' : ''} · mean ${f(stats.mean)} · variance ${f(stats.variance)}${stats.zeros ? ` · ${stats.zeros} zeros` : ''}`
        : stats.kind === 'sparse'
          ? `sparse · ${stats.nonZero} entries · norm ${f(stats.norm)}${stats.maxIndex !== null ? ` · highest index ${stats.maxIndex}` : ''}`
          : `binary · ${stats.bits} bits · ${stats.ones} set`}
    </div>
  );
}

/**
 * The embedding map: a sample of vectors projected to 2D on the server.
 * Colours are the three hues that stay distinct on every pair (validated per
 * theme); further values fold into "Other", and "(none)" is drawn hollow so it
 * is told apart by shape, not colour alone. Every point is also in the table.
 */
type MapMethod = 'pca' | 'umap' | 'tsne';

function MapView({ base, collection, fields, vectorName, vectorKind, partition }: { base: string; collection: string; fields: string[]; vectorName: string; vectorKind: VectorKind; partition: string }) {
  const { theme } = useTheme();
  const c = useChart();
  const palette = SCATTER[theme];
  const [sample, setSample] = useState(500);
  const [method, setMethod] = useState<MapMethod>('pca');
  const [dims, setDims] = useState<2 | 3>(2);
  const [colorBy, setColorBy] = useState('');
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [map, setMap] = useState<ExplorerMap | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draw = async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sample: String(sample), method, dims: String(dims) });
      if (colorBy) params.set('colorBy', colorBy);
      if (vectorName) params.set('vectorName', vectorName);
      if (partition) params.set('partition', partition);
      const f = toFilter(filters);
      if (f) params.set('filter', JSON.stringify(f));
      const { data } = await apiClient.get<ExplorerMap>(`${base}/collections/${encodeURIComponent(collection)}/map?${params}`);
      setMap(data);
    } catch (e) {
      setError(extractErrorMessage(e, 'Could not draw the map.'));
    } finally {
      setBusy(false);
    }
  };

  const colourOf = (group: string | null, i: number) => (group === null || group === 'Other' || group === '(none)' ? palette.other : palette.groups[i] ?? palette.other);
  const series = map ? (map.colorBy ? map.groups.map((g) => g.value) : [null]) : [];
  // Colour follows the value (alphabetical among the named groups), not its count, so redraws keep colours.
  const named = series.filter((g) => g !== null && g !== 'Other' && g !== '(none)').sort();

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="metric-label">Embedding map - a sample projected to 2D or 3D on the server; this read is audited</div>
      {vectorKind !== 'dense' && <div style={{ fontSize: 13, color: 'var(--warning)' }}>▲ The map projects dense vectors; '{vectorName}' is {vectorKind}. Choose a dense vector above.</div>}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Sample
          <select value={sample} onChange={(e) => setSample(Number(e.target.value))} style={{ fontSize: 13, padding: '4px 6px' }}>
            {[100, 250, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} records
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Projection
          <select value={method} onChange={(e) => setMethod(e.target.value as MapMethod)} style={{ fontSize: 13, padding: '4px 6px' }}>
            <option value="pca">PCA - distances along the axes mean something</option>
            <option value="umap">UMAP - shows clusters</option>
            <option value="tsne">t-SNE - sharpest clusters, slowest</option>
          </select>
        </label>
        <div role="radiogroup" aria-label="Dimensions" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {([2, 3] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={dims === d} onClick={() => setDims(d)} style={{ padding: '4px 12px', border: 'none', fontSize: 13, background: dims === d ? 'var(--primary-strong)' : 'var(--surface-2)', color: dims === d ? '#fff' : 'var(--text)' }}>
              {d}D
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Colour by
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value)} style={{ fontSize: 13, padding: '4px 6px' }}>
            <option value="">(nothing)</option>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FilterEditor fields={fields} value={filters} onChange={setFilters} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button type="button" className="primary-btn" disabled={busy || vectorKind !== 'dense'} onClick={draw}>
          {busy ? 'Drawing…' : map ? 'Redraw' : 'Draw map'}
        </button>
        {map && map.points.length > 0 && (
          <button type="button" onClick={() => setAsTable((v) => !v)} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 13 }}>
            {asTable ? 'Show the map' : 'Show as a table'}
          </button>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      {map && (
        <>
          <div style={{ fontSize: 13 }}>
            <strong>{map.sampled.toLocaleString()}</strong> of {map.requested.toLocaleString()} requested · {map.dimension ?? '—'} dimensions{map.vectorName ? ` of '${map.vectorName}'` : ''} · {map.method === 'tsne' ? 't-SNE' : map.method.toUpperCase()} {map.dims ?? 2}D
            {map.explainedVariance && (
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · the axes keep {map.explainedVariance.map((v) => `${Math.round(v * 1000) / 10}%`).join(', ')} of the variance
              </span>
            )}
          </div>
          {map.colorBy && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }} aria-label="Legend">
              {series.map((g) => {
                const i = named.indexOf(g);
                const hollow = g === '(none)';
                return (
                  <span key={String(g)} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: hollow ? 'transparent' : colourOf(g, i), border: `2px solid ${colourOf(g, i)}` }} />
                    {g} ({map.groups.find((x) => x.value === g)?.count ?? 0})
                  </span>
                );
              })}
            </div>
          )}
          {map.points.length > 0 &&
            (asTable ? (
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                <Table headers={['ID', ...(map.colorBy ? [map.colorBy] : []), 'x', 'y', ...(map.dims === 3 ? ['z'] : [])]} rows={map.points.map((p) => [<code key="id">{p.id}</code>, ...(map.colorBy ? [p.group ?? '—'] : []), p.x.toFixed(3), p.y.toFixed(3), ...(map.dims === 3 ? [(p.z ?? 0).toFixed(3)] : [])])} />
              </div>
            ) : map.dims === 3 ? (
              <Scatter3D points={map.points} colourOf={(g) => colourOf(g, named.indexOf(g))} hollow={(g) => g === '(none)'} colorBy={map.colorBy} surface={c.surface} axis={c.axis} />
            ) : (
              <ResponsiveContainer width="100%" height={460}>
                <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke={c.grid} />
                  <XAxis type="number" dataKey="x" name="x" tick={c.tick} stroke={c.axis} tickFormatter={(n: number) => n.toFixed(1)} />
                  <YAxis type="number" dataKey="y" name="y" tick={c.tick} stroke={c.axis} tickFormatter={(n: number) => n.toFixed(1)} width={48} />
                  <Tooltip
                    cursor={{ stroke: c.axis }}
                    content={({ active, payload }) => {
                      const p = active && payload?.[0] ? (payload[0].payload as ExplorerMap['points'][number]) : null;
                      return p ? (
                        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}>
                          <div>
                            <code>{p.id}</code>
                          </div>
                          {map.colorBy && (
                            <div style={{ color: 'var(--muted)' }}>
                              {map.colorBy}: {p.group}
                            </div>
                          )}
                        </div>
                      ) : null;
                    }}
                  />
                  {series.map((g) => {
                    const i = named.indexOf(g);
                    const colour = colourOf(g, i);
                    const hollow = g === '(none)';
                    return (
                      <Scatter
                        key={String(g)}
                        name={String(g ?? 'records')}
                        data={map.points.filter((p) => (map.colorBy ? p.group === g : true))}
                        fill={colour}
                        isAnimationActive={false}
                        shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={4} fill={hollow ? 'none' : colour} stroke={hollow ? colour : c.surface} strokeWidth={hollow ? 1.5 : 1} />}
                      />
                    );
                  })}
                </ScatterChart>
              </ResponsiveContainer>
            ))}
          {map.notes.map((n) => (
            <div key={n} style={{ fontSize: 12, color: 'var(--muted)' }}>
              {n}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * A 3D scatter drawn in SVG: drag (or use the arrow keys) to turn it. An
 * orthographic view, painted back to front, with nearer points slightly
 * larger - no WebGL, so it works everywhere the rest of the page does.
 */
function Scatter3D({ points, colourOf, hollow, colorBy, surface, axis }: { points: ExplorerMap['points']; colourOf: (group: string | null) => string; hollow: (group: string | null) => boolean; colorBy: string | null; surface: string; axis: string }) {
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.35);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 460;

  // Centre and scale the cloud to a unit sphere once.
  const scaled = useMemo(() => {
    const n = points.length || 1;
    const c = [0, 0, 0];
    for (const p of points) {
      c[0] += p.x / n;
      c[1] += p.y / n;
      c[2] += (p.z ?? 0) / n;
    }
    let r = 0;
    for (const p of points) r = Math.max(r, Math.hypot(p.x - c[0], p.y - c[1], (p.z ?? 0) - c[2]));
    return points.map((p) => [(p.x - c[0]) / (r || 1), (p.y - c[1]) / (r || 1), ((p.z ?? 0) - c[2]) / (r || 1)]);
  }, [points]);

  const view = (v: number[]) => {
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    const x1 = v[0] * cy + v[2] * sy;
    const z1 = -v[0] * sy + v[2] * cy;
    const y2 = v[1] * cp - z1 * sp;
    const z2 = v[1] * sp + z1 * cp;
    const s = Math.min(W, H) * 0.42;
    return { sx: W / 2 + x1 * s, sy: H / 2 - y2 * s, depth: z2 };
  };
  const projected = scaled.map((v, i) => ({ i, ...view(v) })).sort((a, b) => a.depth - b.depth);
  const axes = [
    { label: 'x', end: [1, 0, 0] },
    { label: 'y', end: [0, 1, 0] },
    { label: 'z', end: [0, 0, 1] },
  ].map((a) => ({ label: a.label, from: view([0, 0, 0]), to: view(a.end.map((x) => x * 0.9)) }));
  const hovered = hover === null ? null : points[hover];
  const hoveredAt = hover === null ? null : view(scaled[hover]);

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxHeight: 460, cursor: drag ? 'grabbing' : 'grab', touchAction: 'none', outline: 'none' }}
        role="img"
        aria-label="3D embedding map. Drag or use the arrow keys to turn it; the table view lists every point."
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          setDrag({ x: e.clientX, y: e.clientY });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          setYaw((y) => y + (e.clientX - drag.x) * 0.01);
          setPitch((p) => Math.max(-1.5, Math.min(1.5, p + (e.clientY - drag.y) * 0.01)));
          setDrag({ x: e.clientX, y: e.clientY });
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onKeyDown={(e) => {
          const step = 0.1;
          if (e.key === 'ArrowLeft') setYaw((y) => y - step);
          else if (e.key === 'ArrowRight') setYaw((y) => y + step);
          else if (e.key === 'ArrowUp') setPitch((p) => Math.max(-1.5, p - step));
          else if (e.key === 'ArrowDown') setPitch((p) => Math.min(1.5, p + step));
          else return;
          e.preventDefault();
        }}
      >
        {axes.map((a) => (
          <g key={a.label}>
            <line x1={a.from.sx} y1={a.from.sy} x2={a.to.sx} y2={a.to.sy} stroke={axis} strokeWidth={1} strokeDasharray="4 4" />
            <text x={a.to.sx + 4} y={a.to.sy - 4} fontSize={12} fill="var(--muted)">
              {a.label}
            </text>
          </g>
        ))}
        {projected.map(({ i, sx, sy, depth }) => {
          const g = points[i].group;
          const colour = colourOf(g);
          const r = 3.2 + (depth + 1) * 1.1;
          return (
            <circle
              key={points[i].id}
              cx={sx}
              cy={sy}
              r={hover === i ? r + 2 : r}
              fill={hollow(g) ? 'none' : colour}
              stroke={hollow(g) ? colour : surface}
              strokeWidth={hollow(g) ? 1.5 : 1}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover((h) => (h === i ? null : h))}
            />
          );
        })}
      </svg>
      {hovered && hoveredAt && (
        <div style={{ position: 'absolute', left: `${(hoveredAt.sx / W) * 100}%`, top: `${(hoveredAt.sy / H) * 100}%`, transform: 'translate(10px, -110%)', pointerEvents: 'none', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>
          <code>{hovered.id}</code>
          {colorBy && (
            <div style={{ color: 'var(--muted)' }}>
              {colorBy}: {hovered.group}
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Drag, or focus the map and use the arrow keys, to turn it. Nearer points are drawn larger.</div>
    </div>
  );
}

/** Score spread of one search: a large gap between the top two means one clear best match. */
function StatsLine({ stats }: { stats?: ExplorerSearchResult['stats'] }) {
  if (!stats || !stats.count) return null;
  const f = (n: number | null) => (n === null ? '—' : n.toFixed(4));
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
      scores: max {f(stats.max)} · median {f(stats.median)} · mean {f(stats.mean)} · min {f(stats.min)} · std dev {f(stats.stdDev ?? null)} · gap top-2 {f(stats.topGap)}
      {stats.topZ !== null && stats.topZ !== undefined && (
        <span title="How far the top score stands above the rest, in standard deviations: under 1 the list is flat, above 2 the top result stands out.">
          {' '}
          · top stands out {stats.topZ.toFixed(1)}σ{stats.topZ >= 2 ? ' (clear best match)' : stats.topZ < 1 ? ' (flat list)' : ''}
        </span>
      )}
    </div>
  );
}

type Side = { mode: SearchMode; alpha: number; topK: number; filters: FilterState; fusion: Fusion; minScore: string };
const SIDE_DEFAULT: Side = { mode: 'dense', alpha: 0.5, topK: 10, filters: NO_FILTERS, fusion: 'rrf', minScore: '' };

/** One side's settings in the comparison. */
function SideSettings({ label, side, onChange, fields, keyword, native }: { label: string; side: Side; onChange: (s: Side) => void; fields: string[]; keyword: { supported: boolean }; native: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <strong style={{ fontSize: 13 }}>{label}</strong>
      <div style={{ display: 'flex', gap: 10, fontSize: 13, flexWrap: 'wrap', alignItems: 'center' }}>
        <select aria-label={`${label} mode`} value={side.mode} onChange={(e) => onChange({ ...side, mode: e.target.value as SearchMode })} style={{ fontSize: 13, padding: '4px 6px' }}>
          <option value="dense">Dense</option>
          <option value="keyword" disabled={!keyword.supported}>
            Keyword
          </option>
          <option value="hybrid" disabled={!keyword.supported}>
            Hybrid
          </option>
        </select>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Top K
          <input type="number" min={1} max={50} value={side.topK} onChange={(e) => onChange({ ...side, topK: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: 60, fontSize: 13, padding: '4px 6px' }} />
        </label>
        {side.mode === 'hybrid' && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {Math.round(side.alpha * 100)}% dense
            <input type="range" min={0} max={1} step={0.1} value={side.alpha} onChange={(e) => onChange({ ...side, alpha: Number(e.target.value) })} aria-label={`${label} dense weight`} style={{ width: 120 }} />
          </label>
        )}
        {side.mode === 'hybrid' && (
          <select aria-label={`${label} fusion`} value={side.fusion} onChange={(e) => onChange({ ...side, fusion: e.target.value as Fusion })} style={{ fontSize: 13, padding: '4px 6px' }}>
            <option value="rrf">Rank fusion</option>
            <option value="weighted">Weighted scores</option>
            <option value="native" disabled={!native}>
              Database's own
            </option>
          </select>
        )}
        {!(side.mode === 'hybrid' && side.fusion === 'native') && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Min score
            <input type="number" step="any" value={side.minScore} onChange={(e) => onChange({ ...side, minScore: e.target.value })} placeholder="none" aria-label={`${label} minimum score`} style={{ width: 80, fontSize: 13, padding: '4px 6px' }} />
          </label>
        )}
      </div>
      <FilterEditor fields={fields} value={side.filters} onChange={(filters) => onChange({ ...side, filters })} />
    </div>
  );
}

/**
 * The same query run two ways - dense vs hybrid, two weightings, with and
 * without a filter - side by side, with how much the result lists overlap.
 */
function CompareView({ base, collection, fields, keyword, nativeHybrid, vectorName, vectorKind, partition }: { base: string; collection: string; fields: string[]; keyword: { supported: boolean; ranking: string | null }; nativeHybrid: boolean; vectorName: string; vectorKind: VectorKind; partition: string }) {
  const [text, setText] = useState('');
  const [a, setA] = useState<Side>(SIDE_DEFAULT);
  const [b, setB] = useState<Side>(keyword.supported ? { ...SIDE_DEFAULT, mode: 'hybrid' } : { ...SIDE_DEFAULT, topK: 20 });
  const [result, setResult] = useState<ExplorerCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toSide = (s: Side) => {
    const native = s.mode === 'hybrid' && s.fusion === 'native';
    const min = s.minScore.trim() && !native && Number.isFinite(Number(s.minScore)) ? { minScore: Number(s.minScore) } : {};
    return { mode: s.mode, topK: s.topK, ...(s.mode === 'hybrid' ? { alpha: s.alpha, fusion: s.fusion } : {}), ...min, filter: toFilter(s.filters), ...(vectorName && s.mode !== 'keyword' ? { vectorName } : {}) };
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiClient.post<ExplorerCompareResult>(`${base}/collections/${encodeURIComponent(collection)}/compare`, { text, a: toSide(a), b: toSide(b), ...(partition ? { partition } : {}) });
      setResult(data);
    } catch (e) {
      setError(extractErrorMessage(e, 'The comparison failed.'));
    } finally {
      setBusy(false);
    }
  };

  const shared = new Set(result?.overlap.rankShifts.map((r) => r.id) ?? []);
  const moved = new Map(result?.overlap.rankShifts.map((r) => [r.id, r.moved]) ?? []);
  const sideTable = (r: ExplorerSearchResult, isB: boolean) => (
    <div style={{ flex: 1, minWidth: 280, overflowX: 'auto' }}>
      <div style={{ fontSize: 13, marginBottom: 4 }}>
        <strong>{isB ? 'B' : 'A'}</strong> · {r.mode}
        {r.alpha !== null ? ` (${Math.round(r.alpha * 100)}% dense)` : ''} · {r.results.length} results · {r.latencyMs} ms
      </div>
      <StatsLine stats={r.stats} />
      <Table
        headers={['#', 'ID', 'Score', ...(isB ? ['vs A'] : ['In B'])]}
        rows={r.results.map((x, i) => [
          String(i + 1),
          <code key="id">{x.id}</code>,
          x.score.toFixed(4),
          isB ? (shared.has(x.id) ? (moved.get(x.id)! > 0 ? `▲ ${moved.get(x.id)}` : moved.get(x.id)! < 0 ? `▼ ${-moved.get(x.id)!}` : '=') : 'new') : shared.has(x.id) ? 'yes' : 'no',
        ])}
      />
    </div>
  );

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="metric-label">Compare - the same query run two ways, side by side</div>
      {vectorKind !== 'dense' && <div style={{ fontSize: 13, color: 'var(--warning)' }}>▲ Compare runs a text query, embedded as a dense vector; '{vectorName}' is {vectorKind}. Choose a dense vector above.</div>}
      <textarea aria-label="Compare text" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder="e.g. termination clause for contractors" style={{ fontSize: 14, padding: 8 }} />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <SideSettings label="A" side={a} onChange={setA} fields={fields} keyword={keyword} native={nativeHybrid} />
        <SideSettings label="B" side={b} onChange={setB} fields={fields} keyword={keyword} native={nativeHybrid} />
      </div>
      <div>
        <button type="button" className="primary-btn" disabled={busy || !text.trim() || vectorKind !== 'dense'} onClick={run}>
          {busy ? 'Comparing…' : 'Compare'}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {result && (
        <>
          <div style={{ fontSize: 13 }}>
            <strong>{result.overlap.shared}</strong> shared · overlap {Math.round(result.overlap.jaccard * 100)}% · {result.overlap.onlyA.length} only in A · {result.overlap.onlyB.length} only in B
            {result.overlap.rankShifts.some((r) => r.moved !== 0) && <span style={{ color: 'var(--muted)' }}> · ▲▼ = places moved in B</span>}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {sideTable(result.a, false)}
            {sideTable(result.b, true)}
          </div>
        </>
      )}
    </div>
  );
}

/** A record id that opens the record in full. */
function IdButton({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(id)} title="Open this record" style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary-text)', textDecoration: 'underline', fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'left' }}>
      {id}
    </button>
  );
}

/** One record in full: every field (long values up to 20,000 characters), and the head of its vector. */
function RecordPanel({ base, collection, id, vectorName, partition, onClose }: { base: string; collection: string; id: string; vectorName: string; partition: string; onClose: () => void }) {
  const [record, setRecord] = useState<ExplorerRecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRecord(null);
    setError(null);
    apiClient
      .get<ExplorerRecordDetail>(`${base}/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}?${new URLSearchParams({ ...(vectorName ? { vectorName } : {}), ...(partition ? { partition } : {}) })}`)
      .then((r) => setRecord(r.data))
      .catch((e) => setError(extractErrorMessage(e, 'Could not read the record.')));
  }, [base, collection, id, vectorName, partition]);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '4px solid var(--primary-text)' }} aria-label="Record detail">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div className="metric-label" style={{ marginBottom: 0 }}>
          Record <code>{id}</code> - read audited
        </div>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 13 }}>
          Close
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {!record && !error && <div style={{ fontSize: 13 }}>Loading…</div>}
      {record && (
        <>
          <Table
            headers={['Field', 'Value']}
            rows={Object.entries(record.metadata).map(([k, v]) => [
              <strong key="k">{k}</strong>,
              <div key="v" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>
                {typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : cell(v)}
              </div>,
            ])}
          />
          {record.kind === 'sparse' ? (
            <>
              <div style={{ fontSize: 13 }}>
                <strong>Sparse vector</strong> · {record.sparse?.nonZero ?? 0} entries set · L2 norm {record.norm ?? '—'}
              </div>
              {record.sparse && record.sparse.top.length > 0 && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  heaviest: {record.sparse.top.map((t) => `${t.index}:${t.value}`).join(', ')}
                  {record.sparse.nonZero > record.sparse.top.length ? `, … ${record.sparse.nonZero - record.sparse.top.length} more` : ''}
                </div>
              )}
            </>
          ) : record.kind === 'binary' ? (
            <>
              <div style={{ fontSize: 13 }}>
                <strong>Binary vector</strong> · {record.bits?.length ?? '—'} bits · {record.bits?.ones ?? '—'} set
              </div>
              {record.bits && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  {record.bits.head.replace(/(.{8})/g, '$1 ').trim()}
                  {record.bits.length > record.bits.head.length ? ` … ${record.bits.length - record.bits.head.length} more` : ''}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 13 }}>
                <strong>Vector</strong> · {record.dimension ?? '—'} dimensions · L2 norm {record.norm ?? '—'}
                {record.norm !== null && Math.abs(record.norm - 1) > 0.01 && <span style={{ color: 'var(--muted)' }}> (not unit length - check whether the model's vectors are normalised)</span>}
              </div>
              {record.vectorHead && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  [{record.vectorHead.join(', ')}
                  {(record.dimension ?? 0) > record.vectorHead.length ? `, … ${(record.dimension ?? 0) - record.vectorHead.length} more` : ''}]
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The project's own connection to its target database, in place of the
 * server's TARGET_* settings. Secret values are write-only: a saved secret
 * shows as set, is kept when its box is left empty, and is cleared only on
 * request.
 */
function ConnectionPanel({ projectId, canEdit, onChanged }: { projectId: string; canEdit: boolean; onChanged: () => void }) {
  const url = `/projects/${projectId}/connection`;
  const [conn, setConn] = useState<ConnectionView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const show = (v: ConnectionView) => {
    setConn(v);
    setDraft(Object.fromEntries(v.fields.filter((f) => !f.secret).map((f) => [f.key, f.value ?? ''])));
    setCleared(new Set());
  };

  useEffect(() => {
    apiClient
      .get<ConnectionView>(url)
      .then((r) => show(r.data))
      .catch((e) => setError(extractErrorMessage(e, 'Could not load the connection.')));
  }, [url]);

  if (error && !conn) return <div className="card error-text">{error}</div>;
  if (!conn) return <div className="card">Loading the connection…</div>;

  /** Only what changed: omitted keeps the saved value, '' clears it. */
  const changes = () => {
    const out: Record<string, string> = {};
    for (const f of conn.fields) {
      const typed = draft[f.key] ?? '';
      if (f.secret) {
        if (typed) out[f.key] = typed;
        else if (cleared.has(f.key)) out[f.key] = '';
      } else if (conn.source === 'server' ? typed !== '' : typed !== (f.value ?? '')) {
        out[f.key] = typed;
      }
    }
    return out;
  };
  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(extractErrorMessage(e, `${what} failed.`));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act('Saving', async () => {
      const { data } = await apiClient.put<ConnectionView>(url, { settings: changes() });
      show(data);
      setTest(null);
      setNotice('Saved. Ingestion, deployment, benchmarks and the Data Explorer now use this connection for this project.');
      onChanged();
    });
  const runTest = () =>
    act('The test', async () => {
      const c = changes();
      const { data } = await apiClient.post<ConnectionTestResult>(`${url}/test`, Object.keys(c).length ? { settings: c } : {});
      setTest(data);
    });
  const remove = () =>
    act('Removing', async () => {
      await apiClient.delete(url);
      const { data } = await apiClient.get<ConnectionView>(url);
      show(data);
      setConfirmRemove(false);
      setTest(null);
      setNotice("Removed. This project uses the server's settings again.");
      onChanged();
    });

  const pending = Object.keys(changes()).length > 0;
  const canSave = canEdit && conn.encryptionAvailable && !busy;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="metric-label">Connection - {conn.platform}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {conn.source === 'project'
          ? `This project uses its own connection${conn.updatedBy ? `, last saved by ${conn.updatedBy}` : ''}${conn.updatedAt ? ` on ${new Date(conn.updatedAt).toLocaleString()}` : ''}.`
          : "This project uses the server's TARGET_* settings. Save settings here to give it its own connection - used by ingestion, deployment, benchmarks and the Data Explorer."}{' '}
        Secret values are stored encrypted and never shown again.
      </div>
      {conn.inactiveProfileFor && <div style={{ fontSize: 13, color: 'var(--warning)' }}>▲ A connection saved for {conn.inactiveProfileFor} (the project's previous platform) is kept but not used.</div>}
      {!conn.encryptionAvailable && (
        <div style={{ fontSize: 13, color: 'var(--warning)' }}>
          ▲ The server has no <code>CONNECTION_SECRET_KEY</code>, so project connections cannot be saved. Settings are never stored unencrypted.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, max-content) minmax(0, 1fr)', gap: '8px 12px', alignItems: 'center', fontSize: 13, maxWidth: 720 }}>
        {conn.fields.map((f) => {
          const isCleared = cleared.has(f.key);
          const placeholder = f.secret && f.set && !isCleared ? '•••••• saved - leave empty to keep' : f.hint ?? '';
          return (
            <label key={f.key} style={{ display: 'contents' }}>
              <span>
                {f.label}
                {f.required && <span aria-hidden="true"> *</span>}
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{f.key}</div>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete={f.secret ? 'new-password' : 'off'}
                  value={draft[f.key] ?? ''}
                  placeholder={placeholder}
                  disabled={!canEdit}
                  maxLength={2000}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '5px 8px' }}
                />
                {f.secret && f.set && canEdit && (
                  <button
                    type="button"
                    className="secondary-btn"
                    style={{ fontSize: 12, padding: '3px 8px' }}
                    onClick={() => {
                      const next = new Set(cleared);
                      if (isCleared) next.delete(f.key);
                      else next.add(f.key);
                      setCleared(next);
                      setDraft({ ...draft, [f.key]: '' });
                    }}
                  >
                    {isCleared ? 'Keep' : 'Clear'}
                  </button>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {canEdit ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="primary-btn" disabled={!canSave || (!pending && conn.source === 'project')} onClick={save}>
            {busy ? 'Working…' : 'Save connection'}
          </button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={runTest}>
            {pending ? 'Test these settings' : 'Test connection'}
          </button>
          {conn.source === 'project' &&
            (confirmRemove ? (
              <>
                <span style={{ fontSize: 13 }}>Use the server settings again?</span>
                <button type="button" className="secondary-btn" disabled={busy} onClick={remove}>
                  Yes, remove
                </button>
                <button type="button" className="secondary-btn" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="secondary-btn" disabled={busy} onClick={() => setConfirmRemove(true)}>
                Remove - use server settings
              </button>
            ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Admins and architects can change and test the connection.</div>
      )}
      {test && (
        <div role="status" style={{ fontSize: 13, color: test.connected ? 'var(--success)' : 'var(--danger)' }}>
          {test.connected ? '✓ Connected' : '✕ Not connected'} ({test.source === 'unsaved' ? 'unsaved settings' : test.source === 'project' ? "project's settings" : 'server settings'}, {test.latencyMs} ms)
          {test.message && <span style={{ color: 'var(--muted)' }}> - {test.message}</span>}
        </div>
      )}
      {notice && <div style={{ fontSize: 13 }}>{notice}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
          {headers.map((h) => (
            <th key={h} style={{ padding: '6px 8px', fontWeight: 600 }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            {r.map((c, j) => (
              <td key={j} style={{ padding: '6px 8px', verticalAlign: 'top', maxWidth: 360, overflowWrap: 'anywhere' }}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
