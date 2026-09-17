import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  apiClient,
  ArchitectureDecisionRecord,
  DiscoveryAssessmentInput,
  DiscoveryOutcome,
  extractErrorMessage,
  PlainLanguageSummary,
  Project,
} from '../api/client';
import { ExecutiveSummaryCard } from '../components/ExecutiveSummaryCard';
import { PhaseNav } from '../components/PhaseNav';
import { TopBar } from '../components/TopBar';

const DEFAULT_FORM: DiscoveryAssessmentInput = {
  environment: 'production',
  documentCount: 100000,
  documentGrowthPercentPerMonth: 5,
  avgDocumentSizeKb: 50,
  chunksPerDocument: 4,
  estimatedVectorCount: 400000,
  embeddingDimension: 768,
  qps: 20,
  peakQps: 60,
  concurrentUsers: 100,
  targetP95LatencyMs: 150,
  availabilityTargetPercent: 99.9,
  rpoMinutes: 60,
  rtoMinutes: 240,
  retentionDays: 365,
  requiresSimilaritySearch: true,
  requiresSemanticSearch: true,
  requiresHybridSearch: false,
  requiresMetadataFiltering: true,
  requiresFullTextSearch: false,
  topK: 10,
  recallTarget: 0.9,
  hasExistingOracle: false,
  hasExistingPostgres: false,
  hasExistingKubernetes: false,
  deploymentEnvironment: 'cloud',
  availableCpuCores: 8,
  availableRamGb: 32,
  availableStorageGb: 500,
  hasGpu: false,
  requiresAuthentication: true,
  requiresRbac: true,
  requiresEncryptionAtRest: true,
  requiresEncryptionInTransit: true,
  dataResidencyRequirement: '',
  containsPii: false,
  regulatoryRequirements: '',
};

type FieldKey = keyof DiscoveryAssessmentInput;

interface FieldMeta {
  label: string;
  help: string;
  /** True if this input currently changes which platform wins the Phase 1 score. */
  scored: boolean;
}

/**
 * One entry per DTO field. Drives both the form labels and the live "Field
 * guide" panel, so the meaning shown to the user can never drift from the
 * field being rendered.
 */
const FIELD_META: Record<FieldKey, FieldMeta> = {
  environment: {
    label: 'Environment',
    help: 'Labels this assessment as development, staging, or production for your own record-keeping. Does not change the recommendation.',
    scored: false,
  },
  documentCount: {
    label: 'Document count',
    help: 'Total number of source documents you plan to ingest, before chunking, chosen from common corpus-size tiers.',
    scored: false,
  },
  documentGrowthPercentPerMonth: {
    label: 'Document growth (% / month)',
    help: 'Expected month-over-month growth in your corpus. Used later by capacity forecasting (Phase 8) to project when you will outgrow current sizing.',
    scored: false,
  },
  avgDocumentSizeKb: {
    label: 'Average document size (KB)',
    help: 'Typical raw size of one source document, used to reason about ingestion throughput.',
    scored: false,
  },
  chunksPerDocument: {
    label: 'Chunks per document',
    help: 'How many chunks each document is split into before embedding. Multiplied by document count to sanity-check your estimated vector count.',
    scored: false,
  },
  estimatedVectorCount: {
    label: 'Estimated vector count',
    help: 'Total vectors across the whole corpus (documents x chunks per document), chosen from tiers spanning the platform-scoring thresholds. Directly drives platform scoring and the infrastructure (RAM/storage) estimate.',
    scored: true,
  },
  embeddingDimension: {
    label: 'Embedding dimension',
    help: 'Dimensionality of your embedding model’s output vectors, chosen from this platform’s embedding model catalog. Feeds the infrastructure sizing estimate directly; it does not change which platform wins.',
    scored: false,
  },
  qps: {
    label: 'QPS (sustained)',
    help: 'Sustained queries per second under normal load. Used together with peak QPS to score whether an embedded or dedicated platform fits better.',
    scored: true,
  },
  peakQps: {
    label: 'Peak QPS',
    help: 'Highest burst queries per second you expect. The engine scores against the larger of sustained and peak QPS.',
    scored: true,
  },
  concurrentUsers: {
    label: 'Concurrent users',
    help: 'Number of simultaneous users hitting the system at once. Captured for the record; not yet a scored factor.',
    scored: false,
  },
  targetP95LatencyMs: {
    label: 'Target P95 latency (ms)',
    help: 'Your 95th-percentile query latency SLA. Stricter (lower) targets penalize lightweight/embedded platforms in scoring.',
    scored: true,
  },
  availabilityTargetPercent: {
    label: 'Availability target (%)',
    help: 'Uptime SLA, chosen from the standard industry "nines" tiers (cannot exceed 100%). Captured for the ADR and later operational planning; not yet a scored factor.',
    scored: false,
  },
  rpoMinutes: {
    label: 'RPO (minutes)',
    help: 'Recovery Point Objective — maximum acceptable data loss, in minutes, after a failure.',
    scored: false,
  },
  rtoMinutes: {
    label: 'RTO (minutes)',
    help: 'Recovery Time Objective — maximum acceptable time to restore service after a failure.',
    scored: false,
  },
  retentionDays: {
    label: 'Retention (days)',
    help: 'How long ingested data and vectors must be retained before they can be purged.',
    scored: false,
  },
  requiresSimilaritySearch: {
    label: 'Similarity search',
    help: 'Nearest-neighbor vector similarity search is required. Captured to shape the workload description.',
    scored: false,
  },
  requiresSemanticSearch: {
    label: 'Semantic search',
    help: 'Meaning-based (embedding-driven) search, as opposed to exact keyword matching, is required.',
    scored: false,
  },
  requiresHybridSearch: {
    label: 'Hybrid search',
    help: 'Combining vector similarity with keyword/lexical search in a single query is required.',
    scored: false,
  },
  requiresMetadataFiltering: {
    label: 'Metadata filtering',
    help: 'Queries need to filter by structured metadata (e.g. tenant, date, tags) alongside the vector search.',
    scored: false,
  },
  requiresFullTextSearch: {
    label: 'Full-text + vector search',
    help: 'Traditional full-text search needs to run alongside vector search against the same data.',
    scored: false,
  },
  topK: {
    label: 'Top-K',
    help: 'How many results are returned per query, chosen from common values. Used to reason about index tuning in later phases.',
    scored: false,
  },
  recallTarget: {
    label: 'Recall target (0-1)',
    help: 'Target recall@K — the fraction of true nearest neighbors your index must actually return, chosen from standard industry tiers. High targets (e.g. ≥ 0.95) are scored and also raise a risk about larger HNSW ef / IVF nprobe search parameters.',
    scored: true,
  },
  hasExistingOracle: {
    label: 'Existing Oracle Database',
    help: 'You already operate an Oracle Database. Strongly favors Oracle 23ai (vector-enabled) in scoring, since reusing infrastructure is cheaper and lower-risk.',
    scored: true,
  },
  hasExistingPostgres: {
    label: 'Existing PostgreSQL',
    help: 'You already operate PostgreSQL. Strongly favors Postgres + pgvector in scoring.',
    scored: true,
  },
  hasExistingKubernetes: {
    label: 'Existing Kubernetes',
    help: 'You already operate a Kubernetes cluster. Strongly favors Milvus in scoring; without it, Milvus is penalized because a cluster would need to be stood up first.',
    scored: true,
  },
  deploymentEnvironment: {
    label: 'Deployment environment',
    help: 'Where you plan to run the database: cloud, on-premises, or hybrid. Captured for context; not yet a scored factor.',
    scored: false,
  },
  availableCpuCores: {
    label: 'Available CPU cores',
    help: 'CPU capacity you already have available, to compare against the generated infrastructure estimate.',
    scored: false,
  },
  availableRamGb: {
    label: 'Available RAM (GB)',
    help: 'Memory capacity you already have available, to compare against the generated infrastructure estimate.',
    scored: false,
  },
  availableStorageGb: {
    label: 'Available storage (GB)',
    help: 'Storage capacity you already have available, to compare against the generated infrastructure estimate.',
    scored: false,
  },
  hasGpu: {
    label: 'GPU available',
    help: 'Whether a GPU is available. Relevant to embedding generation and index-build performance in later phases.',
    scored: false,
  },
  requiresAuthentication: {
    label: 'Requires authentication',
    help: 'Access to the vector database must be authenticated.',
    scored: false,
  },
  requiresRbac: {
    label: 'Requires RBAC',
    help: 'Role-based access control is required to restrict who can read/write which data.',
    scored: false,
  },
  requiresEncryptionAtRest: {
    label: 'Encryption at rest',
    help: 'Stored data (vectors, metadata) must be encrypted on disk.',
    scored: false,
  },
  requiresEncryptionInTransit: {
    label: 'Encryption in transit',
    help: 'Data must be encrypted while moving over the network (e.g. TLS).',
    scored: false,
  },
  dataResidencyRequirement: {
    label: 'Data residency requirement',
    help: 'Free-text constraint on where data may physically be stored, e.g. "EU-only". Captured for the ADR’s risk section.',
    scored: false,
  },
  containsPii: {
    label: 'Contains PII',
    help: 'The corpus contains personally identifiable information. When true, the engine adds an explicit risk to confirm encryption and data-residency controls end-to-end.',
    scored: true,
  },
  regulatoryRequirements: {
    label: 'Regulatory requirements',
    help: 'Free-text list of applicable regulations, e.g. "HIPAA, GDPR". Captured for the ADR’s risk section.',
    scored: false,
  },
};

interface FieldProps {
  id: FieldKey;
  form: DiscoveryAssessmentInput;
  setForm: (f: DiscoveryAssessmentInput) => void;
  activeField: FieldKey | null;
  setActiveField: (k: FieldKey) => void;
  step?: number;
}

function NumberField({ id, form, setForm, activeField, setActiveField, step = 1 }: FieldProps) {
  const meta = FIELD_META[id];
  return (
    <div className={`field${activeField === id ? ' field-active' : ''}`}>
      <label htmlFor={id}>{meta.label}</label>
      <input
        id={id}
        type="number"
        step={step}
        value={form[id] as number}
        onChange={(e) => setForm({ ...form, [id]: Number(e.target.value) })}
        onFocus={() => setActiveField(id)}
        required
      />
    </div>
  );
}

interface NumericOption {
  value: number;
  label: string;
}

/**
 * Industry-standard availability tiers (the "nines"). Bounded to <= 100% by
 * construction, so there is no invalid value to guard against on submit.
 */
const AVAILABILITY_OPTIONS: NumericOption[] = [
  { value: 99, label: '99% — "two nines" (~3.65 days downtime/year)' },
  { value: 99.5, label: '99.5% (~1.83 days/year)' },
  { value: 99.9, label: '99.9% — "three nines" (~8.76 hours/year) — common SaaS default' },
  { value: 99.95, label: '99.95% (~4.38 hours/year)' },
  { value: 99.99, label: '99.99% — "four nines" (~52.6 minutes/year) — high-availability systems' },
  { value: 99.999, label: '99.999% — "five nines" (~5.26 minutes/year) — telecom-grade' },
];

/** Common recall@K targets used across vector search benchmarks. */
const RECALL_OPTIONS: NumericOption[] = [
  { value: 0.9, label: '0.90 — baseline, acceptable for most RAG use cases' },
  { value: 0.95, label: '0.95 — good; common production target' },
  { value: 0.98, label: '0.98 — high recall' },
  { value: 0.99, label: '0.99 — very high recall' },
  { value: 0.995, label: '0.995 — near-exhaustive search' },
];

/** Typical corpus sizes, from a small pilot to a large enterprise corpus. */
const DOCUMENT_COUNT_OPTIONS: NumericOption[] = [
  { value: 1_000, label: '1,000 — small pilot / PoC' },
  { value: 10_000, label: '10,000 — small production corpus' },
  { value: 50_000, label: '50,000' },
  { value: 100_000, label: '100,000 — typical mid-size corpus' },
  { value: 500_000, label: '500,000' },
  { value: 1_000_000, label: '1,000,000 — large corpus' },
  { value: 5_000_000, label: '5,000,000 — enterprise-scale corpus' },
];

/**
 * Vector-count tiers straddling the same thresholds the recommendation
 * engine scores against (thresholds.yaml `vectorCount`: dedicatedFloor=1M,
 * embeddedMax=5M, dedicatedRecommendedMin=20M), so each option maps to a
 * distinct scoring regime rather than an arbitrary round number.
 */
const VECTOR_COUNT_OPTIONS: NumericOption[] = [
  { value: 10_000, label: '10,000 — small pilot / PoC' },
  { value: 100_000, label: '100,000' },
  { value: 400_000, label: '400,000 — default (100k docs x 4 chunks/doc)' },
  { value: 500_000, label: '500,000 — comfortably embedded-friendly' },
  { value: 1_000_000, label: '1,000,000 — dedicated-platform floor' },
  { value: 5_000_000, label: '5,000,000 — embedded-platform ceiling' },
  { value: 10_000_000, label: '10,000,000' },
  { value: 20_000_000, label: '20,000,000 — dedicated platform recommended' },
  { value: 50_000_000, label: '50,000,000 — large scale' },
  { value: 100_000_000, label: '100,000,000 — very large scale' },
];

/** Dimensions of the embedding models in this platform's catalog (config/embeddings.yaml). */
const EMBEDDING_DIMENSION_OPTIONS: NumericOption[] = [
  { value: 384, label: '384 — e.g. all-MiniLM-L6-v2 (open-source)' },
  { value: 768, label: '768 — e.g. Google text-embedding-004' },
  { value: 1024, label: '1024 — e.g. Cohere embed-v3 / BGE-large' },
  { value: 1536, label: '1536 — e.g. OpenAI text-embedding-3-small' },
  { value: 3072, label: '3072 — e.g. OpenAI text-embedding-3-large' },
];

/** Common top-K values for vector search result sets. */
const TOP_K_OPTIONS: NumericOption[] = [
  { value: 1, label: '1' },
  { value: 3, label: '3' },
  { value: 5, label: '5' },
  { value: 10, label: '10 — common default' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];

function NumericSelectField({
  id,
  form,
  setForm,
  activeField,
  setActiveField,
  options,
}: FieldProps & { options: NumericOption[] }) {
  const meta = FIELD_META[id];
  const current = form[id] as number;
  const hasMatch = options.some((o) => o.value === current);
  return (
    <div className={`field${activeField === id ? ' field-active' : ''}`}>
      <label htmlFor={id}>{meta.label}</label>
      <select
        id={id}
        value={current}
        onChange={(e) => setForm({ ...form, [id]: Number(e.target.value) })}
        onFocus={() => setActiveField(id)}
      >
        {!hasMatch && <option value={current}>{current} (custom, from a previous submission)</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function BoolField({ id, form, setForm, activeField, setActiveField }: FieldProps) {
  const meta = FIELD_META[id];
  const checked = form[id] as boolean;
  return (
    <label
      className={`checkbox-chip${checked ? ' checked' : ''}${activeField === id ? ' field-active' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => setForm({ ...form, [id]: e.target.checked })}
        onFocus={() => setActiveField(id)}
      />
      {meta.label}
    </label>
  );
}

function TextField({ id, form, setForm, activeField, setActiveField }: FieldProps) {
  const meta = FIELD_META[id];
  return (
    <div className={`field${activeField === id ? ' field-active' : ''}`}>
      <label htmlFor={id}>{meta.label}</label>
      <input
        id={id}
        type="text"
        value={(form[id] as string) ?? ''}
        onChange={(e) => setForm({ ...form, [id]: e.target.value })}
        onFocus={() => setActiveField(id)}
        placeholder={id === 'dataResidencyRequirement' ? 'e.g. EU-only' : 'e.g. HIPAA, GDPR'}
      />
    </div>
  );
}

function HelpPanel({ activeField }: { activeField: FieldKey | null }) {
  const meta = activeField ? FIELD_META[activeField] : null;
  return (
    <aside className="help-panel">
      <div className="help-panel-heading">Field guide</div>
      {meta ? (
        <>
          <div className="help-panel-field">{meta.label}</div>
          <p className="help-panel-desc">{meta.help}</p>
          <span className={`status-pill${meta.scored ? ' validated' : ''}`}>
            {meta.scored ? 'Used in platform scoring' : 'Captured for the record'}
          </span>
        </>
      ) : (
        <p className="help-panel-desc">
          Click or tab into any field below to see what it means and whether it changes the Phase 1
          platform recommendation.
        </p>
      )}
    </aside>
  );
}

const VERDICT_TONE: Record<PlainLanguageSummary['verdict'], 'validated' | 'warning' | 'danger'> = {
  'Excellent Fit': 'validated',
  'Good Fit': 'validated',
  'Workable Fit': 'warning',
  'Weak Fit': 'danger',
};

function PlainLanguageCard({ summary }: { summary: PlainLanguageSummary }) {
  return (
    <ExecutiveSummaryCard
      badge={{ text: summary.verdict, tone: VERDICT_TONE[summary.verdict] }}
      headline={summary.headline}
      scorecard={summary.scorecard}
      note={{ label: 'Cost & Operational Effort', value: summary.costAndEffort }}
      considerations={summary.risks}
      bottomLine={summary.bottomLine}
    />
  );
}

function AdrView({ adr }: { adr: ArchitectureDecisionRecord }) {
  const [showTechnical, setShowTechnical] = useState(!adr.plainLanguageSummary);
  return (
    <div>
      {adr.plainLanguageSummary ? (
        <PlainLanguageCard summary={adr.plainLanguageSummary} />
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: '#5a6472', margin: 0 }}>
            This assessment was run before the plain-English summary existed. Re-run the assessment to get one.
          </p>
        </div>
      )}

      <button
        type="button"
        className="primary-btn"
        style={{ marginBottom: 16, background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)' }}
        onClick={() => setShowTechnical((v) => !v)}
      >
        {showTechnical ? 'Hide technical details' : 'Show technical details'}
      </button>

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label">Decision (rules v{adr.rulesVersion})</div>
        <div className="metric-value" style={{ fontSize: 22, textTransform: 'uppercase' }}>
          {adr.decision}
        </div>
        <p style={{ fontSize: 13, color: '#5a6472' }}>{adr.rationale}</p>
        <span className="status-pill">Operational complexity: {adr.operationalComplexity}</span>
      </div>
      )}

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
        <div className="metric-label" style={{ marginBottom: 6 }}>
          Scored options
        </div>
        <p style={{ fontSize: 12, color: '#5a6472', margin: '0 0 10px' }}>
          Each candidate is scored 0-1 on seven weighted criteria (vector-volume fit, query throughput, latency fit,
          recall fit, existing-platform fit, operational complexity, and cost) using the thresholds and weights in
          rules v{adr.rulesVersion}. Each criterion score is multiplied by its weight and the results are summed into
          the total score. A platform that fails a required search capability (hybrid search, full-text search, or
          metadata filtering) is marked ineligible below and cannot win regardless of score; among eligible
          candidates, whichever totals highest wins.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
              <th style={{ padding: '6px 8px' }}>Platform</th>
              <th style={{ padding: '6px 8px' }}>Eligible</th>
              <th style={{ padding: '6px 8px' }}>Total</th>
              <th style={{ padding: '6px 8px' }}>Vector Count</th>
              <th style={{ padding: '6px 8px' }}>QPS</th>
              <th style={{ padding: '6px 8px' }}>Latency</th>
              <th style={{ padding: '6px 8px' }}>Recall</th>
              <th style={{ padding: '6px 8px' }}>Existing</th>
              <th style={{ padding: '6px 8px' }}>Ops</th>
              <th style={{ padding: '6px 8px' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {adr.options.map((o) => (
              <tr key={o.platformId} style={{ borderBottom: '1px solid #eceff3', fontWeight: o.platformId === adr.decision ? 600 : 400 }}>
                <td style={{ padding: '6px 8px' }}>{o.label}</td>
                <td style={{ padding: '6px 8px' }} title={o.ineligibleReasons.join(' ')}>
                  {o.eligible ? 'Yes' : 'No'}
                </td>
                <td style={{ padding: '6px 8px' }}>{o.totalScore.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.vectorCount.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.qps.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.latency.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.recall.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.existingPlatform.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.operationalComplexity.toFixed(2)}</td>
                <td style={{ padding: '6px 8px' }}>{o.criteriaScores.cost.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 14 }}>
          {adr.options.map((o) => (
            <details key={o.platformId} style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Why {o.label} scored this way
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#5a6472' }}>
                {o.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </div>
      )}

      {showTechnical && (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-grid" style={{ marginBottom: 14 }}>
          <div className="card">
            <div className="metric-label">Raw Vector Data</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedRawVectorGb} GB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated Memory</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedMemoryGb} GB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated Storage</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedStorageGb} GB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated CPU Cores</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedCpuCores}</div>
          </div>
        </div>
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>How these figures are calculated</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#5a6472' }}>
            {adr.infrastructureEstimate.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      </div>
      )}

      {showTechnical && (
      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Rejected alternatives</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {adr.rejectedAlternatives.map((r) => (
              <li key={r.platformId}>{r.reason}</li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="metric-label">Risks</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {adr.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="metric-label">Assumptions</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {adr.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </div>
      )}
    </div>
  );
}

export function DiscoveryPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [form, setForm] = useState<DiscoveryAssessmentInput>(DEFAULT_FORM);
  const [outcome, setOutcome] = useState<DiscoveryOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [activeField, setActiveField] = useState<FieldKey | null>(null);

  useEffect(() => {
    if (!id) return;
    apiClient.get<Project>(`/projects/${id}`).then((res) => setProject(res.data));
    apiClient
      .get<DiscoveryOutcome>(`/projects/${id}/discovery/assessments/latest`)
      .then((res) => {
        setOutcome(res.data);
        // res.data.assessment carries persistence fields (id/version/createdAt)
        // the submit DTO rejects (forbidNonWhitelisted) - strip them before
        // seeding the editable form.
        const { id: _id, version: _version, createdAt: _createdAt, ...input } = res.data.assessment;
        setForm(input);
        setShowForm(false);
      })
      .catch(() => {
        // No assessment yet - keep defaults and show the form.
      });
  }, [id]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await apiClient.post<DiscoveryOutcome>(`/projects/${id}/discovery/assessments`, form);
      setOutcome(data);
      setShowForm(false);
      const { data: refreshedProject } = await apiClient.get<Project>(`/projects/${id}`);
      setProject(refreshedProject);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not submit the discovery assessment.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!project) {
    return <div className="main-content">Loading...</div>;
  }

  const fieldProps = { form, setForm, activeField, setActiveField };

  return (
    <div className="app-shell">
      <div className="sidebar">
        <h1>{project.name}</h1>
        <PhaseNav project={project} />
      </div>
      <div className="main-content">
        <TopBar title="Phase 1 - Discovery: Use Case & Scale Assessment" />

        {outcome && !showForm && (
          <div style={{ marginBottom: 20 }}>
            <button className="primary-btn" onClick={() => setShowForm(true)}>
              Re-run Assessment (v{outcome.assessment.version + 1})
            </button>{' '}
            <Link to={`/projects/${project.id}/platform`} style={{ fontSize: 13, marginLeft: 10 }}>
              Manually override this decision
            </Link>
          </div>
        )}

        {outcome && !showForm && <AdrView adr={outcome.adr} />}

        {showForm && (
          <div className="discovery-layout">
            <form className="discovery-form" onSubmit={onSubmit}>
              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">1</span>
                  <h2 className="discovery-section-title">Corpus & scale</h2>
                </div>
                <p className="discovery-section-sub">
                  How much data you're ingesting and how many vectors it produces.
                </p>
                <div className="field-grid">
                  <NumericSelectField id="documentCount" {...fieldProps} options={DOCUMENT_COUNT_OPTIONS} />
                  <NumberField id="documentGrowthPercentPerMonth" {...fieldProps} step={0.1} />
                  <NumberField id="avgDocumentSizeKb" {...fieldProps} step={0.1} />
                  <NumberField id="chunksPerDocument" {...fieldProps} />
                  <NumericSelectField id="estimatedVectorCount" {...fieldProps} options={VECTOR_COUNT_OPTIONS} />
                  <NumericSelectField id="embeddingDimension" {...fieldProps} options={EMBEDDING_DIMENSION_OPTIONS} />
                </div>
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">2</span>
                  <h2 className="discovery-section-title">Performance & SLAs</h2>
                </div>
                <p className="discovery-section-sub">Query load and the reliability targets you need to hit.</p>
                <div className="field-grid">
                  <NumberField id="qps" {...fieldProps} step={0.1} />
                  <NumberField id="peakQps" {...fieldProps} step={0.1} />
                  <NumberField id="concurrentUsers" {...fieldProps} />
                  <NumberField id="targetP95LatencyMs" {...fieldProps} />
                  <NumericSelectField id="availabilityTargetPercent" {...fieldProps} options={AVAILABILITY_OPTIONS} />
                  <NumberField id="rpoMinutes" {...fieldProps} />
                  <NumberField id="rtoMinutes" {...fieldProps} />
                  <NumberField id="retentionDays" {...fieldProps} />
                </div>
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">3</span>
                  <h2 className="discovery-section-title">Search capabilities</h2>
                </div>
                <p className="discovery-section-sub">What kind of search the application needs to run.</p>
                <div className="checkbox-grid">
                  <BoolField id="requiresSimilaritySearch" {...fieldProps} />
                  <BoolField id="requiresSemanticSearch" {...fieldProps} />
                  <BoolField id="requiresHybridSearch" {...fieldProps} />
                  <BoolField id="requiresMetadataFiltering" {...fieldProps} />
                  <BoolField id="requiresFullTextSearch" {...fieldProps} />
                </div>
                <div className="field-grid">
                  <NumericSelectField id="topK" {...fieldProps} options={TOP_K_OPTIONS} />
                  <NumericSelectField id="recallTarget" {...fieldProps} options={RECALL_OPTIONS} />
                </div>
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">4</span>
                  <h2 className="discovery-section-title">Existing infrastructure & environment</h2>
                </div>
                <p className="discovery-section-sub">
                  What you already run today, and the capacity you have available.
                </p>
                <div className="checkbox-grid">
                  <BoolField id="hasExistingOracle" {...fieldProps} />
                  <BoolField id="hasExistingPostgres" {...fieldProps} />
                  <BoolField id="hasExistingKubernetes" {...fieldProps} />
                  <BoolField id="hasGpu" {...fieldProps} />
                </div>
                <div className="field-grid">
                  <div className={`field${activeField === 'deploymentEnvironment' ? ' field-active' : ''}`}>
                    <label htmlFor="deploymentEnvironment">{FIELD_META.deploymentEnvironment.label}</label>
                    <select
                      id="deploymentEnvironment"
                      value={form.deploymentEnvironment}
                      onChange={(e) => setForm({ ...form, deploymentEnvironment: e.target.value as any })}
                      onFocus={() => setActiveField('deploymentEnvironment')}
                    >
                      <option value="cloud">Cloud</option>
                      <option value="on_premises">On-premises</option>
                      <option value="hybrid">Hybrid</option>
                    </select>
                  </div>
                  <div className={`field${activeField === 'environment' ? ' field-active' : ''}`}>
                    <label htmlFor="environment">{FIELD_META.environment.label}</label>
                    <select
                      id="environment"
                      value={form.environment}
                      onChange={(e) => setForm({ ...form, environment: e.target.value as any })}
                      onFocus={() => setActiveField('environment')}
                    >
                      <option value="development">Development</option>
                      <option value="staging">Staging</option>
                      <option value="production">Production</option>
                    </select>
                  </div>
                  <NumberField id="availableCpuCores" {...fieldProps} step={0.5} />
                  <NumberField id="availableRamGb" {...fieldProps} step={0.5} />
                  <NumberField id="availableStorageGb" {...fieldProps} step={1} />
                </div>
              </section>

              <section className="discovery-section">
                <div className="discovery-section-header">
                  <span className="discovery-section-index">5</span>
                  <h2 className="discovery-section-title">Security & compliance</h2>
                </div>
                <p className="discovery-section-sub">
                  Controls the data needs, and any regulatory constraints on it.
                </p>
                <div className="checkbox-grid">
                  <BoolField id="requiresAuthentication" {...fieldProps} />
                  <BoolField id="requiresRbac" {...fieldProps} />
                  <BoolField id="requiresEncryptionAtRest" {...fieldProps} />
                  <BoolField id="requiresEncryptionInTransit" {...fieldProps} />
                  <BoolField id="containsPii" {...fieldProps} />
                </div>
                <div className="field-grid">
                  <TextField id="dataResidencyRequirement" {...fieldProps} />
                  <TextField id="regulatoryRequirements" {...fieldProps} />
                </div>
              </section>

              {error && <div className="error-text">{error}</div>}
              <button className="primary-btn" type="submit" disabled={submitting}>
                {submitting ? 'Scoring architecture options...' : 'Run Discovery Assessment'}
              </button>
            </form>

            <HelpPanel activeField={activeField} />
          </div>
        )}
      </div>
    </div>
  );
}
