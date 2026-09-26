import { ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient, extractErrorMessage, Project } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useFeatures } from '../api/features';
import { CheckStatus, ExplorerCollections, ExplorerDocuments, ExplorerOverview, ExplorerSearchResult, ExplorerStatus } from '../api/dataExplorer';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

type View = 'overview' | 'documents' | 'search';
type FilterRow = { field: string; value: string };

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
  const [error, setError] = useState<string | null>(null);
  const base = `/projects/${id}/data-explorer`;

  useEffect(() => {
    if (!id) return;
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
  }, [id, base]);

  useEffect(() => {
    if (!collection) return;
    setOverview(null);
    apiClient
      .get<ExplorerOverview>(`${base}/collections/${encodeURIComponent(collection)}`)
      .then((r) => setOverview(r.data))
      .catch((e) => setError(extractErrorMessage(e, 'Could not describe the collection.')));
  }, [collection, base]);

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
                {!collections.collections.length && <span style={{ fontSize: 13, color: 'var(--muted)' }}>The database has no vector collections yet.</span>}
                {collections.designedCollection && !collections.collections.some((c) => c.designed) && (
                  <span style={{ fontSize: 13, color: 'var(--warning)' }}>▲ The designed collection '{collections.designedCollection}' is not deployed.</span>
                )}
                <span style={{ flex: 1 }} />
                <div role="tablist" aria-label="View" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                  {(['overview', 'documents', 'search'] as View[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      onClick={() => setView(v)}
                      style={{ padding: '6px 14px', border: 'none', fontSize: 13, background: view === v ? 'var(--primary-strong)' : 'var(--surface-2)', color: view === v ? '#fff' : 'var(--text)' }}
                    >
                      {v === 'overview' ? 'Overview' : v === 'documents' ? 'Documents' : 'Search'}
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
            {collection && view === 'documents' && canRead && overview && <DocumentsView key={collection} base={base} collection={collection} fields={overview.info.fields.map((f) => f.name)} />}
            {collection && view === 'search' && canRead && overview && <SearchView key={collection} base={base} collection={collection} fields={overview.info.fields.map((f) => f.name)} />}
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

/** Up to five exact-match conditions; fields come from the collection itself. */
function FilterEditor({ fields, rows, onChange }: { fields: string[]; rows: FilterRow[]; onChange: (rows: FilterRow[]) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <select aria-label="Filter field" value={r.field} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} style={{ fontSize: 13, padding: '4px 6px' }}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <span>=</span>
          <input aria-label="Filter value" value={r.value} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ fontSize: 13, padding: '4px 6px', width: 200 }} />
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 12 }}>
            Remove
          </button>
        </div>
      ))}
      {fields.length > 0 && rows.length < 5 && (
        <button type="button" onClick={() => onChange([...rows, { field: fields[0], value: '' }])} style={{ alignSelf: 'start', background: 'none', border: 'none', color: 'var(--primary-text)', fontSize: 12, padding: 0 }}>
          + Add a filter
        </button>
      )}
    </div>
  );
}
const toFilter = (rows: FilterRow[]) => Object.fromEntries(rows.filter((r) => r.field && r.value !== '').map((r) => [r.field, r.value]));

function DocumentsView({ base, collection, fields }: { base: string; collection: string; fields: string[] }) {
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [applied, setApplied] = useState<Record<string, string>>({});
  // Cursors of the pages visited, so Previous can go back.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState<ExplorerDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    setError(null);
    const params = new URLSearchParams({ limit: '25' });
    if (cursor) params.set('cursor', cursor);
    if (Object.keys(applied).length) params.set('filter', JSON.stringify(applied));
    apiClient
      .get<ExplorerDocuments>(`${base}/collections/${encodeURIComponent(collection)}/documents?${params}`)
      .then((r) => setPage(r.data))
      .catch((e) => setError(extractErrorMessage(e, 'Could not read records.')));
  }, [base, collection, cursor, applied]);

  const cols = page ? [...new Set(page.rows.flatMap((r) => Object.keys(r.metadata)))] : [];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowX: 'auto' }}>
      <div className="metric-label">Records - 25 per page, long values shortened; this read is audited</div>
      <FilterEditor fields={fields} rows={filters} onChange={setFilters} />
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
      {error && <div className="error-text">{error}</div>}
      {page && (
        <>
          <Table headers={['ID', ...cols, 'Vector']} rows={page.rows.map((r) => [<code key="id">{r.id}</code>, ...cols.map((c) => cell(r.metadata[c])), <span key="v" style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{r.vectorPreview ? `[${r.vectorPreview.join(', ')}${(r.dimension ?? 0) > r.vectorPreview.length ? ', …' : ''}] · ${r.dimension}d` : '—'}</span>])} />
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

function SearchView({ base, collection, fields }: { base: string; collection: string; fields: string[] }) {
  const [mode, setMode] = useState<'text' | 'vector'>('text');
  const [text, setText] = useState('');
  const [vectorText, setVectorText] = useState('');
  const [topK, setTopK] = useState(10);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [result, setResult] = useState<ExplorerSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(null);
    let vector: number[] | undefined;
    if (mode === 'vector') {
      try {
        vector = JSON.parse(vectorText);
        if (!Array.isArray(vector)) throw new Error();
      } catch {
        setError('The vector must be a JSON array of numbers, e.g. [0.12, -0.4, …].');
        return;
      }
    }
    setBusy(true);
    try {
      const { data } = await apiClient.post<ExplorerSearchResult>(`${base}/collections/${encodeURIComponent(collection)}/search`, {
        ...(mode === 'text' ? { text } : { vector }),
        topK,
        filter: toFilter(filters),
      });
      setResult(data);
    } catch (e) {
      setError(extractErrorMessage(e, 'The search failed.'));
    } finally {
      setBusy(false);
    }
  };

  const cols = result ? [...new Set(result.results.flatMap((r) => Object.keys(r.metadata)))] : [];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowX: 'auto' }}>
      <div className="metric-label">Search - text is embedded with the project's embedding model, as ingestion does</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" checked={mode === 'text'} onChange={() => setMode('text')} /> Text
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" checked={mode === 'vector'} onChange={() => setMode('vector')} /> Vector (JSON array)
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Top K
          <input type="number" min={1} max={50} value={topK} onChange={(e) => setTopK(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 70, fontSize: 13, padding: '4px 6px' }} />
        </label>
      </div>
      {mode === 'text' ? (
        <textarea aria-label="Search text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder="e.g. termination clause for contractors" style={{ fontSize: 14, padding: 8 }} />
      ) : (
        <textarea aria-label="Search vector" value={vectorText} onChange={(e) => setVectorText(e.target.value)} rows={3} placeholder="[0.12, -0.4, …]" style={{ fontSize: 13, padding: 8, fontFamily: 'var(--font-mono)' }} />
      )}
      <FilterEditor fields={fields} rows={filters} onChange={setFilters} />
      <div>
        <button type="button" className="primary-btn" disabled={busy || (mode === 'text' ? !text.trim() : !vectorText.trim())} onClick={run}>
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
          </div>
          <Table headers={['#', 'ID', 'Score', ...cols]} rows={result.results.map((r, i) => [String(i + 1), <code key="id">{r.id}</code>, r.score.toFixed(4), ...cols.map((c) => cell(r.metadata[c]))])} />
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
