import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  apiClient,
  ChunkingConfig,
  ChunkingPreviewResult,
  ChunkingStrategy,
  DataPipelineDesign,
  DiscoveryOutcome,
  EmbeddingProviderCatalogEntry,
  extractErrorMessage,
  GENERATED_SCHEMA_PLATFORMS,
  MetadataField,
  Project,
} from '../api/client';
import { ExecutiveSummaryCard } from '../components/ExecutiveSummaryCard';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const STRATEGIES: Array<{ value: ChunkingStrategy; label: string }> = [
  { value: 'fixed_size', label: 'Fixed-size' },
  { value: 'token_based', label: 'Token-based (word count)' },
  { value: 'sentence_based', label: 'Sentence-based' },
  { value: 'paragraph_based', label: 'Paragraph-based' },
  { value: 'recursive', label: 'Recursive' },
  { value: 'semantic', label: 'Semantic (heuristic)' },
  { value: 'sliding_window', label: 'Sliding-window' },
];

const STRATEGY_HELP: Record<ChunkingStrategy, string> = {
  fixed_size: 'Splits text into fixed-length character windows with a set overlap. Simple and predictable, but can cut sentences mid-way.',
  token_based: 'Splits text into fixed-length word windows (a proxy for subword tokens). Useful when you need to reason about size in tokens.',
  sentence_based: 'Groups whole sentences together up to the target chunk size. Keeps sentences intact, at the cost of variable chunk sizes.',
  paragraph_based: 'Groups whole paragraphs together up to the target chunk size. Preserves paragraph structure; best for well-formatted documents.',
  recursive: 'Splits by paragraph, falling back to sentence, then fixed-size windows for any piece still too large. A common, robust default for RAG.',
  semantic: 'Approximated via sentence-boundary grouping (true embedding-similarity boundary detection requires a live embedding call at ingestion).',
  sliding_window: 'Character windows anchored so the final window always ends exactly at the text end, avoiding a tiny trailing chunk.',
};

const DEFAULT_CHUNKING: ChunkingConfig = { strategy: 'recursive', chunkSize: 500, chunkOverlap: 50, minChunkSize: 50, maxChunkSize: 1000 };
const DEFAULT_OVERLAP_RATIO = 0.1;

const SAMPLE_TEXT = `Vector databases store high-dimensional embeddings and support approximate nearest-neighbor search.

They are commonly used for retrieval-augmented generation, semantic search, and recommendation systems.

Choosing a chunking strategy affects retrieval quality: chunks that are too large dilute relevance, while chunks that are too small lose context.`;

interface ChunkSizeOption {
  value: number;
  label: string;
}

/** A metadata field row carries a stable client-side id so React can track each row correctly when one is removed from the middle of the list. */
interface MetadataFieldRow extends MetadataField {
  rowId: string;
}

function makeRowId(): string {
  return Math.random().toString(36).slice(2);
}

function chunkSizeOptions(unit: 'characters' | 'words'): ChunkSizeOption[] {
  const presets = unit === 'words' ? [100, 200, 300, 500, 750] : [256, 500, 1000, 1500, 2000];
  const descriptions = [
    'short, precise chunks',
    'common default',
    'more context per chunk',
    'long-form context',
    'maximum context, coarser retrieval',
  ];
  return presets.map((value, i) => ({ value, label: `${value} ${unit} — ${descriptions[i]}` }));
}

const OVERLAP_RATIO_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'No overlap (0%)' },
  { value: 0.1, label: '10% of chunk size — light continuity' },
  { value: 0.15, label: '15% of chunk size — common default' },
  { value: 0.2, label: '20% of chunk size — strong continuity' },
  { value: 0.25, label: '25% of chunk size — maximum recommended overlap' },
];

/** Picks the catalog model whose dimension matches the Phase 1 target most closely; exact match wins, else the closest. */
function recommendModel(
  providers: EmbeddingProviderCatalogEntry[],
  targetDimension: number | null,
): { providerId: string; modelId: string } | null {
  const flat = providers.flatMap((p) => p.models.map((m) => ({ providerId: p.id, modelId: m.id, dimension: m.dimension })));
  if (flat.length === 0) return null;
  if (targetDimension == null) return { providerId: flat[0].providerId, modelId: flat[0].modelId };
  const exact = flat.find((m) => m.dimension === targetDimension);
  const pick =
    exact ?? flat.reduce((best, m) => (Math.abs(m.dimension - targetDimension) < Math.abs(best.dimension - targetDimension) ? m : best));
  return { providerId: pick.providerId, modelId: pick.modelId };
}

type FieldKey =
  | 'collectionName'
  | 'strategy'
  | 'chunkSize'
  | 'chunkOverlap'
  | 'minChunkSize'
  | 'maxChunkSize'
  | 'embeddingProvider'
  | 'embeddingModel'
  | 'metadataFields';

function fieldHelp(key: FieldKey, strategy: ChunkingStrategy): string {
  switch (key) {
    case 'collectionName':
      return 'The database table or collection where processed vectors and their metadata will be stored.';
    case 'strategy':
      return `How documents are split into chunks before embedding. ${STRATEGY_HELP[strategy]}`;
    case 'chunkSize':
      return 'The target size of each chunk. Smaller chunks retrieve more precisely; larger chunks preserve more surrounding context.';
    case 'chunkOverlap':
      return 'How much of the previous chunk is repeated at the start of the next one, so context is not lost right at a chunk boundary.';
    case 'minChunkSize':
      return 'A trailing chunk smaller than this is merged into the previous one, avoiding tiny, low-value final chunks.';
    case 'maxChunkSize':
      return 'A hard ceiling chunks are never allowed to exceed, even if the chosen strategy would otherwise produce a larger one.';
    case 'embeddingProvider':
      return 'The company/service that generates your vector embeddings. Pre-selected to match the embedding dimension estimated in Phase 1, if available.';
    case 'embeddingModel':
      return 'The specific embedding model. Determines vector dimension, per-token cost, quality tier, and language support - shown below once selected.';
    case 'metadataFields':
      return 'Structured fields stored alongside each vector (e.g. source URL, date). Used for metadata filtering at query time (Phase 1 requirement).';
    default:
      return '';
  }
}

function HelpPanel({ activeField, strategy }: { activeField: FieldKey | null; strategy: ChunkingStrategy }) {
  return (
    <aside className="help-panel">
      <div className="help-panel-heading">Field guide</div>
      {activeField ? (
        <p className="help-panel-desc" style={{ marginBottom: 0 }}>
          {fieldHelp(activeField, strategy)}
        </p>
      ) : (
        <p className="help-panel-desc" style={{ marginBottom: 0 }}>
          Click or tab into any field below to see what it means and how it shapes the generated pipeline.
        </p>
      )}
    </aside>
  );
}

export function DataPipelineDesignPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [collectionName, setCollectionName] = useState('documents');
  const [chunking, setChunking] = useState<ChunkingConfig>(DEFAULT_CHUNKING);
  const [overlapRatio, setOverlapRatio] = useState<number>(DEFAULT_OVERLAP_RATIO);
  const [sampleText, setSampleText] = useState(SAMPLE_TEXT);
  const [preview, setPreview] = useState<ChunkingPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<FieldKey | null>(null);

  const [providers, setProviders] = useState<EmbeddingProviderCatalogEntry[]>([]);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [recommendedDimension, setRecommendedDimension] = useState<number | null>(null);

  const [metadataFields, setMetadataFields] = useState<MetadataFieldRow[]>([{ rowId: makeRowId(), name: 'source_url', type: 'string' }]);

  const [design, setDesign] = useState<DataPipelineDesign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      const [projectRes, catalogRes] = await Promise.all([
        apiClient.get<Project>(`/projects/${id}`),
        apiClient.get<EmbeddingProviderCatalogEntry[]>('/embeddings/catalog'),
      ]);
      if (cancelled) return;
      setProject(projectRes.data);
      setProviders(catalogRes.data);

      let targetDimension: number | null = null;
      try {
        const discoveryRes = await apiClient.get<DiscoveryOutcome>(`/projects/${id}/discovery/assessments/latest`);
        targetDimension = discoveryRes.data.assessment.embeddingDimension;
      } catch {
        // No Discovery assessment yet - fall back to the catalog's first model.
      }

      let existingDesign: DataPipelineDesign | null = null;
      try {
        const designRes = await apiClient.get<DataPipelineDesign>(`/projects/${id}/data-pipeline/designs/latest`);
        existingDesign = designRes.data;
      } catch {
        // No design yet.
      }

      if (cancelled) return;

      if (existingDesign) {
        setDesign(existingDesign);
        setCollectionName(existingDesign.collectionName);
        setChunking({
          strategy: existingDesign.chunkingStrategy,
          chunkSize: existingDesign.chunkSize,
          chunkOverlap: existingDesign.chunkOverlap,
          minChunkSize: existingDesign.minChunkSize,
          maxChunkSize: existingDesign.maxChunkSize,
        });
        setOverlapRatio(existingDesign.chunkSize > 0 ? existingDesign.chunkOverlap / existingDesign.chunkSize : DEFAULT_OVERLAP_RATIO);
        setProviderId(existingDesign.embeddingProviderId);
        setModelId(existingDesign.embeddingModelId);
        setMetadataFields(existingDesign.metadataFields.map((f) => ({ ...f, rowId: makeRowId() })));
        setShowForm(false);
      } else {
        setRecommendedDimension(targetDimension);
        const recommended = recommendModel(catalogRes.data, targetDimension);
        if (recommended) {
          setProviderId(recommended.providerId);
          setModelId(recommended.modelId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const selectedProvider = providers.find((p) => p.id === providerId);
  const selectedModel = selectedProvider?.models.find((m) => m.id === modelId);
  const chunkUnit: 'characters' | 'words' = chunking.strategy === 'token_based' ? 'words' : 'characters';

  const onPreview = async () => {
    setPreviewError(null);
    setPreview(null);
    try {
      const { data } = await apiClient.post<ChunkingPreviewResult>('/chunking/preview', { text: sampleText, config: chunking });
      setPreview(data);
    } catch (err: any) {
      setPreviewError(extractErrorMessage(err, 'Could not preview chunking.'));
    }
  };

  const updateField = (rowId: string, field: Partial<MetadataField>) => {
    setMetadataFields((fields) => fields.map((f) => (f.rowId === rowId ? { ...f, ...field } : f)));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await apiClient.post<DataPipelineDesign>(`/projects/${id}/data-pipeline/designs`, {
        collectionName,
        chunking,
        embeddingProviderId: providerId,
        embeddingModelId: modelId,
        // Strip the client-only rowId (used for stable React keys) - the API's
        // ValidationPipe rejects any property not on MetadataFieldDto.
        metadataFields: metadataFields.map(({ rowId, ...field }) => field),
      });
      setDesign(data);
      setShowForm(false);
      setShowTechnical(false);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not submit the data pipeline design.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!project) {
    return <div className="main-content">Loading...</div>;
  }

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Phase 2 - Design: Data & Embedding Strategy" />

        {design && !showForm && (
          <div style={{ marginBottom: 20 }}>
            <button className="primary-btn" onClick={() => setShowForm(true)}>
              Revise Design (v{design.version + 1})
            </button>
          </div>
        )}

        {design && !showForm && (
          <div>
            {design.executiveSummary && (
              <ExecutiveSummaryCard
                headline={design.executiveSummary.headline}
                scorecard={design.executiveSummary.scorecard}
                note={{ label: 'Cost & Effort', value: design.executiveSummary.costAndEffort }}
                considerations={design.executiveSummary.considerations}
                bottomLine={design.executiveSummary.bottomLine}
              />
            )}

            <button
              type="button"
              className="primary-btn"
              style={{ marginBottom: 16, background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)' }}
              onClick={() => setShowTechnical((v) => !v)}
            >
              {showTechnical ? 'Hide technical details' : 'Show technical details'}
            </button>

            {showTechnical && design.validationWarnings.length > 0 && (
              <div className="card" style={{ marginBottom: 16, borderColor: '#c0392b' }}>
                <div className="metric-label">Validation warnings</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {design.validationWarnings.map((w) => (
                    <li key={w} className="error-text">
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {showTechnical && (
              <div className="card-grid" style={{ marginBottom: 16 }}>
                <div className="card">
                  <div className="metric-label">Chunking strategy</div>
                  <div className="metric-value" style={{ fontSize: 16 }}>
                    {design.chunkingStrategy.replace('_', ' ')}
                  </div>
                </div>
                <div className="card">
                  <div className="metric-label">Embedding model</div>
                  <div className="metric-value" style={{ fontSize: 16 }}>
                    {design.embeddingProviderId} / {design.embeddingModelId}
                  </div>
                </div>
                <div className="card">
                  <div className="metric-label">Vector dimension</div>
                  <div className="metric-value">{design.embeddingDimension}</div>
                </div>
                <div className="card">
                  <div className="metric-label">Cost / 1M tokens</div>
                  <div className="metric-value">${design.costPerMillionTokens}</div>
                </div>
              </div>
            )}

            {showTechnical && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="metric-label" style={{ marginBottom: 8 }}>
                  Data Pipeline: Source -&gt; Extract -&gt; Clean -&gt; Chunk -&gt; Embed -&gt; Validate -&gt; Store -&gt; Index
                </div>
                <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
                  {design.pipelineStages.map((s) => (
                    <li key={s.name} style={{ marginBottom: 4 }}>
                      <strong>{s.name}:</strong> {s.description}
                    </li>
                  ))}
                </ol>
                <div style={{ marginTop: 10, fontSize: 13, color: '#5a6472' }}>
                  Error handling: {design.errorHandling.retryCount} retries @ {design.errorHandling.retryBackoffMs}ms backoff,
                  dead-letter {design.errorHandling.deadLetterEnabled ? 'enabled' : 'disabled'}, batch size{' '}
                  {design.errorHandling.batchSize}.
                </div>
              </div>
            )}

            {showTechnical && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="metric-label" style={{ marginBottom: 8 }}>
                  Metadata fields
                </div>
                {design.metadataFields.length === 0 ? (
                  <p style={{ fontSize: 13, color: '#5a6472', margin: 0 }}>No metadata fields configured.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
                        <th style={{ padding: '4px 8px' }}>Field</th>
                        <th style={{ padding: '4px 8px' }}>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {design.metadataFields.map((f) => (
                        <tr key={f.name} style={{ borderBottom: '1px solid #eceff3' }}>
                          <td style={{ padding: '4px 8px' }}>{f.name}</td>
                          <td style={{ padding: '4px 8px' }}>{f.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {showTechnical && (
              <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
                <div className="metric-label" style={{ marginBottom: 4 }}>
                  Generated schemas
                </div>
                <p style={{ fontSize: 12, color: '#5a6472', margin: '0 0 10px' }}>
                  Every supported platform's schema/config is generated for reference, regardless of which one this project uses -
                  see Phase 4 (Implementation) for the schema actually deployed.
                </p>
                {GENERATED_SCHEMA_PLATFORMS.map(({ key, label }) => {
                  const output = design.generatedSchemas[key];
                  if (!output) {
                    // This design was generated before schema support for this platform was added.
                    return (
                      <details key={key} style={{ marginBottom: 8 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#5a6472' }}>{label}</summary>
                        <p style={{ fontSize: 12, color: '#5a6472', margin: '6px 0 0' }}>
                          Not available for this design version - re-run "Revise Design" to generate it.
                        </p>
                      </details>
                    );
                  }
                  const body = 'ddl' in output ? output.ddl : JSON.stringify(output.schema, null, 2);
                  return (
                    <details key={key} style={{ marginBottom: 8 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{label}</summary>
                      <pre style={{ background: '#f5f6f8', padding: 10, borderRadius: 6, fontSize: 12, overflowX: 'auto', marginTop: 6 }}>{body}</pre>
                      {output.notes.length > 0 && (
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#5a6472' }}>
                          {output.notes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </details>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {showForm && (
          <div className="discovery-layout">
            <form className="discovery-form" onSubmit={onSubmit}>
              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">1</span>
                  <h2 className="discovery-section-title">Collection</h2>
                </div>
                <p className="discovery-section-sub">Where processed vectors and metadata will be stored.</p>
                <div className="field-grid">
                  <div className={`field${activeField === 'collectionName' ? ' field-active' : ''}`}>
                    <label htmlFor="collectionName">Table / collection name</label>
                    <input
                      id="collectionName"
                      value={collectionName}
                      onChange={(e) => setCollectionName(e.target.value)}
                      onFocus={() => setActiveField('collectionName')}
                      required
                    />
                  </div>
                </div>
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">2</span>
                  <h2 className="discovery-section-title">Chunking strategy</h2>
                </div>
                <p className="discovery-section-sub">How source documents are split before embedding.</p>
                <div className="field-grid">
                  <div className={`field${activeField === 'strategy' ? ' field-active' : ''}`}>
                    <label htmlFor="strategy">Strategy</label>
                    <select
                      id="strategy"
                      value={chunking.strategy}
                      onChange={(e) => setChunking({ ...chunking, strategy: e.target.value as ChunkingStrategy })}
                      onFocus={() => setActiveField('strategy')}
                    >
                      {STRATEGIES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={`field${activeField === 'chunkSize' ? ' field-active' : ''}`}>
                    <label htmlFor="chunkSize">Chunk size ({chunkUnit})</label>
                    <select
                      id="chunkSize"
                      value={chunking.chunkSize}
                      onChange={(e) => {
                        const chunkSize = Number(e.target.value);
                        setChunking({ ...chunking, chunkSize, chunkOverlap: Math.round(chunkSize * overlapRatio) });
                      }}
                      onFocus={() => setActiveField('chunkSize')}
                    >
                      {!chunkSizeOptions(chunkUnit).some((o) => o.value === chunking.chunkSize) && (
                        <option value={chunking.chunkSize}>
                          {chunking.chunkSize} {chunkUnit} (custom, from a previous submission)
                        </option>
                      )}
                      {chunkSizeOptions(chunkUnit).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={`field${activeField === 'chunkOverlap' ? ' field-active' : ''}`}>
                    <label htmlFor="chunkOverlap">
                      Chunk overlap ({chunking.chunkOverlap} {chunkUnit})
                    </label>
                    <select
                      id="chunkOverlap"
                      value={overlapRatio}
                      onChange={(e) => {
                        const ratio = Number(e.target.value);
                        setOverlapRatio(ratio);
                        setChunking({ ...chunking, chunkOverlap: Math.round(chunking.chunkSize * ratio) });
                      }}
                      onFocus={() => setActiveField('chunkOverlap')}
                    >
                      {!OVERLAP_RATIO_OPTIONS.some((o) => o.value === overlapRatio) && (
                        <option value={overlapRatio}>{(overlapRatio * 100).toFixed(0)}% (custom, from a previous submission)</option>
                      )}
                      {OVERLAP_RATIO_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={`field${activeField === 'minChunkSize' ? ' field-active' : ''}`}>
                    <label htmlFor="minChunkSize">Min chunk size (optional)</label>
                    <input
                      id="minChunkSize"
                      type="number"
                      value={chunking.minChunkSize ?? ''}
                      onChange={(e) => setChunking({ ...chunking, minChunkSize: e.target.value ? Number(e.target.value) : undefined })}
                      onFocus={() => setActiveField('minChunkSize')}
                    />
                  </div>
                  <div className={`field${activeField === 'maxChunkSize' ? ' field-active' : ''}`}>
                    <label htmlFor="maxChunkSize">Max chunk size (optional)</label>
                    <input
                      id="maxChunkSize"
                      type="number"
                      value={chunking.maxChunkSize ?? ''}
                      onChange={(e) => setChunking({ ...chunking, maxChunkSize: e.target.value ? Number(e.target.value) : undefined })}
                      onFocus={() => setActiveField('maxChunkSize')}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <label>Sample text (for preview only)</label>
                  <textarea rows={5} value={sampleText} onChange={(e) => setSampleText(e.target.value)} />
                </div>
                <button type="button" className="primary-btn" onClick={onPreview} style={{ marginTop: 8 }}>
                  Preview chunking
                </button>
                {previewError && <div className="error-text">{previewError}</div>}
                {preview && (
                  <div className="card" style={{ marginTop: 10 }}>
                    <div className="metric-label">
                      {preview.stats.count} chunks - avg {preview.stats.avgSizeChars} chars (min {preview.stats.minSizeChars}, max{' '}
                      {preview.stats.maxSizeChars})
                    </div>
                    {preview.notes.map((n) => (
                      <p key={n} style={{ fontSize: 12, color: '#5a6472', margin: '4px 0' }}>
                        {n}
                      </p>
                    ))}
                    <ol style={{ fontSize: 12, paddingLeft: 18, maxHeight: 220, overflowY: 'auto' }}>
                      {preview.chunks.map((c) => (
                        <li key={c.index} style={{ marginBottom: 6 }}>
                          <em>~{c.approxTokenCount} tokens:</em> {c.text}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">3</span>
                  <h2 className="discovery-section-title">Embedding model</h2>
                </div>
                <p className="discovery-section-sub">
                  {recommendedDimension != null
                    ? `Pre-selected to match the ${recommendedDimension}-dimension target from your Phase 1 assessment. Change it if your requirements differ.`
                    : 'Which model converts each chunk into a vector.'}
                </p>
                <div className="field-grid">
                  <div className={`field${activeField === 'embeddingProvider' ? ' field-active' : ''}`}>
                    <label htmlFor="embeddingProvider">Provider</label>
                    <select
                      id="embeddingProvider"
                      value={providerId}
                      onChange={(e) => {
                        setProviderId(e.target.value);
                        const p = providers.find((pr) => pr.id === e.target.value);
                        setModelId(p?.models[0]?.id ?? '');
                      }}
                      onFocus={() => setActiveField('embeddingProvider')}
                    >
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={`field${activeField === 'embeddingModel' ? ' field-active' : ''}`}>
                    <label htmlFor="embeddingModel">Model</label>
                    <select id="embeddingModel" value={modelId} onChange={(e) => setModelId(e.target.value)} onFocus={() => setActiveField('embeddingModel')}>
                      {selectedProvider?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {selectedModel && (
                  <div style={{ fontSize: 12, color: '#5a6472', marginTop: 8 }}>
                    Dimension {selectedModel.dimension} - max input {selectedModel.maxInputTokens} tokens - $
                    {selectedModel.costPerMillionTokens}/1M tokens - quality {selectedModel.qualityTier} - languages{' '}
                    {selectedModel.languageSupport.join(', ')}
                  </div>
                )}
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">4</span>
                  <h2 className="discovery-section-title">Metadata fields</h2>
                </div>
                <p className="discovery-section-sub">Structured fields stored alongside each vector, for filtering at query time.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {metadataFields.map((field) => (
                    <div key={field.rowId} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        style={{ flex: 1 }}
                        value={field.name}
                        onChange={(e) => updateField(field.rowId, { name: e.target.value })}
                        onFocus={() => setActiveField('metadataFields')}
                        placeholder="field_name"
                      />
                      <select
                        value={field.type}
                        onChange={(e) => updateField(field.rowId, { type: e.target.value as MetadataField['type'] })}
                        onFocus={() => setActiveField('metadataFields')}
                      >
                        <option value="string">string</option>
                        <option value="number">number</option>
                        <option value="boolean">boolean</option>
                        <option value="date">date</option>
                        <option value="json">json</option>
                      </select>
                      <button
                        type="button"
                        className="primary-btn"
                        style={{ background: '#c0392b' }}
                        onClick={() => setMetadataFields((fields) => fields.filter((f) => f.rowId !== field.rowId))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="primary-btn"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => setMetadataFields((fields) => [...fields, { rowId: makeRowId(), name: '', type: 'string' }])}
                  >
                    + Add field
                  </button>
                </div>
              </section>

              {error && <div className="error-text">{error}</div>}
              <button className="primary-btn" type="submit" disabled={submitting}>
                {submitting ? 'Generating schemas...' : 'Generate Data Pipeline Design'}
              </button>
            </form>

            <HelpPanel activeField={activeField} strategy={chunking.strategy} />
          </div>
        )}
      </div>
    </div>
  );
}
