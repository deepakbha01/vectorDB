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
  SensitivityAnalysis,
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
  qpsScope: 'aggregate',
  concurrentUsers: 100,
  targetP95LatencyMs: 150,
  targetP99LatencyMs: 300,
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
  requiresReranking: false,
  hasExistingOracle: false,
  hasExistingPostgres: false,
  hasExistingKubernetes: false,
  existingPlatforms: [],
  deploymentEnvironment: 'cloud',
  availableCpuCores: 8,
  availableRamGb: 32,
  availableStorageGb: 500,
  hasGpu: false,
  operationalCapability: 'part_time',
  requiresMultiRegion: false,
  dataReplicationModel: 'none',
  regionalFailoverRequired: false,
  crossRegionReplicationRequired: false,
  tenancyModel: 'single_tenant',
  requiresAuthentication: true,
  requiresRbac: true,
  requiresEncryptionAtRest: true,
  requiresEncryptionInTransit: true,
  requiresKeyManagement: false,
  requiresTenantIsolation: false,
  requiresAuditLogging: false,
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
  qpsScope: {
    label: 'QPS scope',
    help: 'What the QPS figures above actually measure. Not scored, but materially changes sizing once multi-region is in play - re-run the assessment if this does not match how you measure QPS.',
    scored: false,
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
  targetP99LatencyMs: {
    label: 'Target P99 latency (ms)',
    help: 'Your 99th-percentile (tail) query latency SLA. Not itself scored, but flagged as a risk if it is unusually tight relative to the P95 target.',
    scored: false,
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
    help: 'Combining vector similarity with keyword/lexical search in a single query is required. Platforms that cannot do this (e.g. Chroma, LanceDB) are disqualified from winning, regardless of how well they otherwise score.',
    scored: true,
  },
  requiresMetadataFiltering: {
    label: 'Metadata filtering',
    help: 'Queries need to filter by structured metadata (e.g. tenant, date, tags) alongside the vector search. A platform that cannot do this is disqualified from winning.',
    scored: true,
  },
  requiresFullTextSearch: {
    label: 'Full-text + vector search',
    help: 'Traditional full-text search needs to run alongside vector search against the same data. Uses the same eligibility check as hybrid search, since there is no separate full-text capability flag in the platform catalog.',
    scored: true,
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
  precisionTarget: {
    label: 'Precision target (0-1)',
    help: 'Target precision@K, if you track it separately from recall. Recorded for the record only — ANN index tuning primarily controls recall, not precision, so this is not scored.',
    scored: false,
  },
  requiresReranking: {
    label: 'Reranking',
    help: 'Results are reranked (e.g. with a cross-encoder) after initial retrieval. Assumed to run at the application layer regardless of platform, so it does not change which platform wins.',
    scored: false,
  },
  ndcgTarget: {
    label: 'NDCG@K target (0-1)',
    help: 'Target Normalized Discounted Cumulative Gain, if tracked. Recorded for the record only — this engine only models recall@K, so ranking-quality metrics are not independently scored.',
    scored: false,
  },
  mrrTarget: {
    label: 'MRR target (0-1)',
    help: 'Target Mean Reciprocal Rank, if tracked. Recorded for the record only — not independently scored, for the same reason as NDCG@K.',
    scored: false,
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
  existingPlatforms: {
    label: 'Other existing platforms',
    help: 'Vector database platforms (other than Oracle/PostgreSQL, which have their own checkboxes above) you already operate in production. Already running the exact platform is the strongest possible existing-platform and cost fit for it.',
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
  operationalCapability: {
    label: 'Operational capability',
    help: 'Your team’s day-to-day capacity to run a database. A high-operational-complexity platform is penalized further with little/no capability, and gets a slight boost with a dedicated platform team.',
    scored: true,
  },
  monthlyBudgetUsd: {
    label: 'Monthly budget (USD)',
    help: 'Approximate monthly infrastructure budget, if known. Recorded for the record only — the cost criterion is a directional 0-1 fitness score, not a dollar estimate, so this is not scored directly.',
    scored: false,
  },
  requiresMultiRegion: {
    label: 'Multi-region required',
    help: 'The database must serve reads/writes from more than one geographic region. This tool does not model per-platform cross-region replication capabilities, so every platform is marked "unverified" (not silently assumed eligible) rather than scored - the decision becomes conditional.',
    scored: true,
  },
  deploymentRegionCount: {
    label: 'Deployment regions',
    help: 'Number of geographic regions the database must be deployed across, if multi-region is required.',
    scored: false,
  },
  trafficDistributionPercent: {
    label: 'Traffic distribution',
    help: 'Approximate traffic split across regions, e.g. "50/30/20". Captured for context.',
    scored: false,
  },
  dataReplicationModel: {
    label: 'Data replication model',
    help: 'How data is replicated across regions: none, active-passive, or active-active. Captured for context; not yet a scored factor.',
    scored: false,
  },
  regionalFailoverRequired: {
    label: 'Regional failover required',
    help: 'The system must automatically fail over to another region if one becomes unavailable.',
    scored: false,
  },
  crossRegionReplicationRequired: {
    label: 'Cross-region replication required',
    help: 'Data written in one region must be replicated to other regions.',
    scored: false,
  },
  tenancyModel: {
    label: 'Tenancy model',
    help: 'How tenants share the database: a single tenant, a shared schema across tenants, or a dedicated instance/schema per tenant. Captured for context; not yet a scored factor.',
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
  requiresKeyManagement: {
    label: 'Key management',
    help: 'Customer-managed / bring-your-own-key encryption key management is required. Checked by the PII compliance gate below when the workload contains PII.',
    scored: false,
  },
  requiresTenantIsolation: {
    label: 'Tenant isolation',
    help: "Data belonging to different tenants must be logically or physically isolated. Checked by the PII compliance gate below.",
    scored: false,
  },
  requiresAuditLogging: {
    label: 'Audit logging',
    help: 'Access to the database must be captured in an audit log. Checked by the PII compliance gate below.',
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

/** The 10 catalog platforms other than Oracle/PostgreSQL, which have their own dedicated checkboxes. */
const OTHER_EXISTING_PLATFORM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'milvus', label: 'Milvus' },
  { value: 'pinecone', label: 'Pinecone' },
  { value: 'qdrant', label: 'Qdrant' },
  { value: 'weaviate', label: 'Weaviate' },
  { value: 'chroma', label: 'Chroma' },
  { value: 'elasticsearch', label: 'Elasticsearch / OpenSearch' },
  { value: 'redis', label: 'Redis' },
  { value: 'mongodb_atlas', label: 'MongoDB Atlas' },
  { value: 'lancedb', label: 'LanceDB' },
  { value: 'actian', label: 'Actian Vector' },
];

/** A number field whose value may be entirely absent (cleared -> `undefined`), for genuinely optional inputs like budget/precision. */
function OptionalNumberField({ id, form, setForm, activeField, setActiveField, step = 1, min, max }: FieldProps & { min?: number; max?: number }) {
  const meta = FIELD_META[id];
  const current = form[id] as number | undefined | null;
  return (
    <div className={`field${activeField === id ? ' field-active' : ''}`}>
      <label htmlFor={id}>{meta.label} (optional)</label>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={current == null ? '' : current}
        placeholder="Not specified"
        onChange={(e) => setForm({ ...form, [id]: e.target.value === '' ? undefined : Number(e.target.value) })}
        onFocus={() => setActiveField(id)}
      />
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
        placeholder={id === 'dataResidencyRequirement' ? 'e.g. EU-only' : id === 'trafficDistributionPercent' ? 'e.g. 50/30/20' : 'e.g. HIPAA, GDPR'}
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
  const badgeText = summary.conditionalBadge ?? summary.verdict;
  const badgeTone = summary.conditionalBadge ? (summary.conditionalBadge.includes('Tied') ? 'warning' : 'warning') : VERDICT_TONE[summary.verdict];
  return (
    <ExecutiveSummaryCard
      badge={{ text: badgeText, tone: badgeTone }}
      headline={summary.headline}
      scorecard={summary.scorecard}
      note={{ label: 'Cost & Operational Effort', value: summary.costAndEffort }}
      considerations={summary.risks}
      bottomLine={summary.bottomLine}
    />
  );
}

const DECISION_STATUS_LABEL: Record<ArchitectureDecisionRecord['decisionStatus'], string> = {
  single: 'Single recommendation',
  tied: 'Tied - not an unambiguous winner',
  conditional: 'Conditional recommendation',
};

function DecisionStatusCard({ adr }: { adr: ArchitectureDecisionRecord }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Decision status</div>
          <div className="metric-value" style={{ fontSize: 18 }}>{DECISION_STATUS_LABEL[adr.decisionStatus]}</div>
          {adr.decisionStatus === 'tied' && (
            <p style={{ fontSize: 12, color: '#5a6472' }}>
              Tied with: {adr.tiedPlatformIds.join(', ')}
              {adr.tieBreakStage ? ` — ${adr.tieBreakStage}` : ''}
            </p>
          )}
        </div>
        <div className="card">
          <div className="metric-label">Confidence</div>
          <div className="metric-value" style={{ fontSize: 18, textTransform: 'capitalize' }}>{adr.confidence}</div>
        </div>
      </div>
      {adr.openValidations.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="metric-label">Open before final selection</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {adr.openValidations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BudgetAndComplianceCard({ adr }: { adr: ArchitectureDecisionRecord }) {
  if (!adr.budgetFeasibility && (!adr.complianceGate || !adr.complianceGate.applicable)) {
    return null;
  }
  return (
    <div className="card-grid" style={{ marginBottom: 16 }}>
      {adr.budgetFeasibility && (
        <div className="card">
          <div className="metric-label">Budget feasibility</div>
          <div className="metric-value" style={{ fontSize: 16 }}>${adr.budgetFeasibility.monthlyBudgetUsd}/mo stated</div>
          <span className="status-pill">{adr.budgetFeasibility.status.replace(/_/g, ' ')}</span>
          <p style={{ fontSize: 12, color: '#5a6472' }}>{adr.budgetFeasibility.note}</p>
        </div>
      )}
      {adr.complianceGate && adr.complianceGate.applicable && (
        <div className="card">
          <div className="metric-label">PII compliance gate</div>
          <span className="status-pill">{adr.complianceGate.status}</span>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {adr.complianceGate.checks.map((c) => (
              <li key={c.control} style={{ color: c.satisfied ? 'inherit' : '#b3261e' }}>
                {c.control}: {c.satisfied ? 'captured' : 'not captured'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WhatIfAnalysisCard({ projectId }: { projectId: string }) {
  const [analysis, setAnalysis] = useState<SensitivityAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get<SensitivityAnalysis>(`/projects/${projectId}/discovery/assessments/latest/sensitivity-analysis`);
      setAnalysis(data);
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Could not run sensitivity analysis.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="metric-label" style={{ marginBottom: 6 }}>What-if analysis</div>
      <p style={{ fontSize: 12, color: '#5a6472', margin: '0 0 10px' }}>
        Re-runs the current assessment under a few common what-if scenarios (QPS x2, vector count x2, budget halved, multi-region
        toggled, a stricter recall target) without submitting a new version, so you can see whether the decision is sensitive to
        these inputs before committing to it.
      </p>
      <button type="button" className="primary-btn" onClick={run} disabled={loading}>
        {loading ? 'Running...' : 'Run what-if analysis'}
      </button>
      {error && <p style={{ color: '#b3261e', fontSize: 13 }}>{error}</p>}
      {analysis && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
              <th style={{ padding: '6px 8px' }}>Scenario</th>
              <th style={{ padding: '6px 8px' }}>Decision</th>
              <th style={{ padding: '6px 8px' }}>Changed?</th>
              <th style={{ padding: '6px 8px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #eceff3', color: '#5a6472' }}>
              <td style={{ padding: '6px 8px' }}>Baseline (current assessment)</td>
              <td style={{ padding: '6px 8px' }}>{analysis.baselineDecision}</td>
              <td style={{ padding: '6px 8px' }}>-</td>
              <td style={{ padding: '6px 8px' }}>{analysis.baselineDecisionStatus}</td>
            </tr>
            {analysis.scenarios.map((s) => (
              <tr key={s.scenario} style={{ borderBottom: '1px solid #eceff3', fontWeight: s.decisionChanged ? 600 : 400 }}>
                <td style={{ padding: '6px 8px' }}>{s.scenario}</td>
                <td style={{ padding: '6px 8px' }}>{s.decision}</td>
                <td style={{ padding: '6px 8px' }}>{s.decisionChanged ? 'Yes' : 'No'}</td>
                <td style={{ padding: '6px 8px' }}>{s.decisionStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdrView({ adr, projectId }: { adr: ArchitectureDecisionRecord; projectId: string }) {
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

      {adr.decisionStatus !== undefined && <DecisionStatusCard adr={adr} />}
      <BudgetAndComplianceCard adr={adr} />
      <WhatIfAnalysisCard projectId={projectId} />

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
          Each candidate is scored 0-1 on seven weighted criteria
          {adr.criteriaWeights
            ? ` (vector volume ${(adr.criteriaWeights.vectorCount * 100).toFixed(0)}%, query throughput ${(adr.criteriaWeights.qps * 100).toFixed(0)}%, latency ${(adr.criteriaWeights.latency * 100).toFixed(0)}%, recall ${(adr.criteriaWeights.recall * 100).toFixed(0)}%, existing-platform fit ${(adr.criteriaWeights.existingPlatform * 100).toFixed(0)}%, operational simplicity ${(adr.criteriaWeights.operationalComplexity * 100).toFixed(0)}%, cost ${(adr.criteriaWeights.cost * 100).toFixed(0)}%)`
            : ''}{' '}
          using the thresholds and weights in rules v{adr.rulesVersion}. A platform that fails a required search capability is
          "Ineligible" and cannot win regardless of score; one with an unmodeled requirement (e.g. multi-region) is "Unverified" -
          still winnable, but the decision is then marked conditional. Among eligible/unverified candidates, the highest total
          wins, with ties broken by a deterministic chain (see Decision status above).
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
              <th style={{ padding: '6px 8px' }}>Platform</th>
              <th style={{ padding: '6px 8px' }}>Eligibility</th>
              <th style={{ padding: '6px 8px' }}>Total</th>
              <th style={{ padding: '6px 8px' }}>Vector Count</th>
              <th style={{ padding: '6px 8px' }}>QPS</th>
              <th style={{ padding: '6px 8px' }}>Latency</th>
              <th style={{ padding: '6px 8px' }}>Recall</th>
              <th style={{ padding: '6px 8px' }}>Existing</th>
              <th style={{ padding: '6px 8px' }}>Simplicity</th>
              <th style={{ padding: '6px 8px' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {adr.options
              .filter((o) => o.eligibilityStatus !== 'ineligible')
              .map((o) => (
                <tr key={o.platformId} style={{ borderBottom: '1px solid #eceff3', fontWeight: o.platformId === adr.decision ? 600 : 400 }}>
                  <td style={{ padding: '6px 8px' }}>{o.label}</td>
                  <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>{o.eligibilityStatus}</td>
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

        {adr.options.some((o) => o.eligibilityStatus === 'ineligible') && (
          <div style={{ marginTop: 14 }}>
            <div className="metric-label" style={{ marginBottom: 6 }}>
              Ineligible (cannot win regardless of score)
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #dfe3e8' }}>
                  <th style={{ padding: '6px 8px' }}>Platform</th>
                  <th style={{ padding: '6px 8px' }}>Total</th>
                  <th style={{ padding: '6px 8px' }}>Why ineligible</th>
                </tr>
              </thead>
              <tbody>
                {adr.options
                  .filter((o) => o.eligibilityStatus === 'ineligible')
                  .map((o) => (
                    <tr key={o.platformId} style={{ borderBottom: '1px solid #eceff3', color: '#5a6472' }}>
                      <td style={{ padding: '6px 8px' }}>{o.label}</td>
                      <td style={{ padding: '6px 8px' }}>{o.totalScore.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px' }}>{o.eligibilityNotes.join(' ')}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

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
            <div className="metric-value">{adr.infrastructureEstimate.estimatedRawVectorGb} GiB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated Memory</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedMemoryGb} GiB</div>
          </div>
          <div className="card">
            <div className="metric-label">Estimated Storage</div>
            <div className="metric-value">{adr.infrastructureEstimate.estimatedStorageGb} GiB</div>
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
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label" style={{ marginBottom: 6 }}>Alternatives</div>
        {(
          [
            { bucket: 'tied' as const, title: 'Tied with the decision' },
            { bucket: 'strong' as const, title: 'Strong alternatives' },
            { bucket: 'lower_fit' as const, title: 'Lower fit for this workload' },
            { bucket: 'capacity_constraint' as const, title: 'Capacity/capability constraint' },
          ]
        )
          .map((group) => ({ ...group, items: adr.rejectedAlternatives.filter((r) => r.bucket === group.bucket) }))
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <div key={group.bucket} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{group.title}</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {group.items.map((r) => (
                  <li key={r.platformId}>{r.reason}</li>
                ))}
              </ul>
            </div>
          ))}
      </div>
      )}

      {showTechnical && (
      <div className="card-grid">
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

        {outcome && !showForm && <AdrView adr={outcome.adr} projectId={project.id} />}

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
                  <div className={`field${activeField === 'qpsScope' ? ' field-active' : ''}`}>
                    <label htmlFor="qpsScope">{FIELD_META.qpsScope.label}</label>
                    <select
                      id="qpsScope"
                      value={form.qpsScope}
                      onChange={(e) => setForm({ ...form, qpsScope: e.target.value as any })}
                      onFocus={() => setActiveField('qpsScope')}
                    >
                      <option value="aggregate">Aggregate</option>
                      <option value="per_region">Per-region</option>
                      <option value="per_index">Per-index</option>
                    </select>
                  </div>
                  <NumberField id="concurrentUsers" {...fieldProps} />
                  <NumberField id="targetP95LatencyMs" {...fieldProps} />
                  <NumberField id="targetP99LatencyMs" {...fieldProps} />
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
                  <BoolField id="requiresReranking" {...fieldProps} />
                </div>
                <div className="field-grid">
                  <NumericSelectField id="topK" {...fieldProps} options={TOP_K_OPTIONS} />
                  <NumericSelectField id="recallTarget" {...fieldProps} options={RECALL_OPTIONS} />
                  <OptionalNumberField id="precisionTarget" {...fieldProps} step={0.01} min={0} max={1} />
                  <OptionalNumberField id="ndcgTarget" {...fieldProps} step={0.01} min={0} max={1} />
                  <OptionalNumberField id="mrrTarget" {...fieldProps} step={0.01} min={0} max={1} />
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
                  <BoolField id="requiresMultiRegion" {...fieldProps} />
                </div>
                {form.requiresMultiRegion && (
                  <div className="field-grid" style={{ marginBottom: 14 }}>
                    <OptionalNumberField id="deploymentRegionCount" {...fieldProps} step={1} min={1} />
                    <TextField id="trafficDistributionPercent" {...fieldProps} />
                    <div className={`field${activeField === 'dataReplicationModel' ? ' field-active' : ''}`}>
                      <label htmlFor="dataReplicationModel">{FIELD_META.dataReplicationModel.label}</label>
                      <select
                        id="dataReplicationModel"
                        value={form.dataReplicationModel}
                        onChange={(e) => setForm({ ...form, dataReplicationModel: e.target.value as any })}
                        onFocus={() => setActiveField('dataReplicationModel')}
                      >
                        <option value="none">None</option>
                        <option value="active_passive">Active-passive</option>
                        <option value="active_active">Active-active</option>
                      </select>
                    </div>
                  </div>
                )}
                {form.requiresMultiRegion && (
                  <div className="checkbox-grid" style={{ marginBottom: 14 }}>
                    <BoolField id="regionalFailoverRequired" {...fieldProps} />
                    <BoolField id="crossRegionReplicationRequired" {...fieldProps} />
                  </div>
                )}
                <div className={`field${activeField === 'existingPlatforms' ? ' field-active' : ''}`} style={{ marginBottom: 14 }}>
                  <label>{FIELD_META.existingPlatforms.label}</label>
                  <div className="checkbox-grid">
                    {OTHER_EXISTING_PLATFORM_OPTIONS.map((p) => (
                      <label
                        key={p.value}
                        className={`checkbox-chip${form.existingPlatforms.includes(p.value) ? ' checked' : ''}`}
                        onFocus={() => setActiveField('existingPlatforms')}
                      >
                        <input
                          type="checkbox"
                          checked={form.existingPlatforms.includes(p.value)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              existingPlatforms: e.target.checked
                                ? [...form.existingPlatforms, p.value]
                                : form.existingPlatforms.filter((v) => v !== p.value),
                            })
                          }
                          onFocus={() => setActiveField('existingPlatforms')}
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
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
                  <div className={`field${activeField === 'operationalCapability' ? ' field-active' : ''}`}>
                    <label htmlFor="operationalCapability">{FIELD_META.operationalCapability.label}</label>
                    <select
                      id="operationalCapability"
                      value={form.operationalCapability}
                      onChange={(e) => setForm({ ...form, operationalCapability: e.target.value as any })}
                      onFocus={() => setActiveField('operationalCapability')}
                    >
                      <option value="none">None</option>
                      <option value="part_time">Part-time</option>
                      <option value="dedicated_dba">Dedicated DBA</option>
                      <option value="platform_team">Platform team</option>
                    </select>
                  </div>
                  <OptionalNumberField id="monthlyBudgetUsd" {...fieldProps} step={100} min={0} />
                  <div className={`field${activeField === 'tenancyModel' ? ' field-active' : ''}`}>
                    <label htmlFor="tenancyModel">{FIELD_META.tenancyModel.label}</label>
                    <select
                      id="tenancyModel"
                      value={form.tenancyModel}
                      onChange={(e) => setForm({ ...form, tenancyModel: e.target.value as any })}
                      onFocus={() => setActiveField('tenancyModel')}
                    >
                      <option value="single_tenant">Single tenant</option>
                      <option value="shared_multi_tenant">Shared multi-tenant</option>
                      <option value="dedicated_per_tenant">Dedicated per tenant</option>
                    </select>
                  </div>
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
                  <BoolField id="requiresKeyManagement" {...fieldProps} />
                  <BoolField id="requiresTenantIsolation" {...fieldProps} />
                  <BoolField id="requiresAuditLogging" {...fieldProps} />
                  <BoolField id="containsPii" {...fieldProps} />
                </div>
                {form.containsPii && (
                  <p className="discovery-section-sub" style={{ marginTop: -6 }}>
                    Since this workload contains PII, every checkbox above (plus authentication/RBAC, retention, and RPO/RTO) is checked by
                    the PII compliance gate on submission - any unmet control caps the result at "Conditionally eligible" rather than
                    "Excellent Fit".
                  </p>
                )}
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
