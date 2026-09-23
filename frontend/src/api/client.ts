import axios from 'axios';

export const apiClient = axios.create({ baseURL: '/api' });

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

/**
 * Every page's error handler pulls `err.response.data.message` and renders it
 * directly. The backend's error shape is normally a plain string (or a
 * string[] for field-validation errors), but a bug once let a nested object
 * through - React throws trying to render an object as a child, which blanked
 * the whole page instead of showing an error. This is the one place that
 * extracts an error message, so every page degrades to a readable message
 * instead of a crash even if the API shape is ever wrong again.
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join(', ') || fallback;
  return fallback;
}

/** Machine-readable error code for flows the UI must react to structurally (e.g. a confirmation step), not just display. */
export function extractErrorCode(err: unknown): string | undefined {
  return (err as { response?: { data?: { errorCode?: string } } })?.response?.data?.errorCode;
}

export function extractErrorDetails<T = unknown>(err: unknown): T | undefined {
  return (err as { response?: { data?: { details?: T } } })?.response?.data?.details;
}

export type UserRole = 'admin' | 'architect' | 'viewer';

export interface ApiUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  fullName?: string;
  role: UserRole;
  createdAt: string;
}

export type ProjectPhase =
  | 'discovery'
  | 'data_embeddings'
  | 'index_design'
  | 'vector_db_selection'
  | 'infrastructure'
  | 'ingestion'
  | 'optimization'
  | 'capacity';

export type PhaseStatus = 'not_started' | 'in_progress' | 'completed' | 'validated';

export type CustomerMode = 'new' | 'existing';

export interface Project {
  id: string;
  name: string;
  businessUseCase?: string;
  industry?: string;
  /** AI Factory Pattern Library entry this project started from, if any - always optional. */
  patternId?: string;
  /** New/greenfield vs. existing/modernization. Existing-customer technical context lives on the Discovery assessment's existing-technology fields, not here. */
  customerMode: CustomerMode;
  platform:
    | 'undetermined'
    | 'oracle'
    | 'postgres_pgvector'
    | 'milvus'
    | 'pinecone'
    | 'qdrant'
    | 'weaviate'
    | 'chroma'
    | 'elasticsearch'
    | 'redis'
    | 'mongodb_atlas'
    | 'lancedb'
    | 'actian';
  platformIsManualOverride: boolean;
  platformDecisionRationale?: string;
  phaseStatuses: Record<ProjectPhase, PhaseStatus>;
  createdAt: string;
}

export interface PlatformCatalogEntry {
  id: string;
  label: string;
  operationalComplexity: string;
  requiresKubernetes?: boolean;
}

/**
 * An AI Factory Pattern Library entry (refactoring spec S4) - a reusable
 * starting point for a new project. `defaultAssessment` only seeds fields it
 * has an opinion on; every value stays fully editable on Phase 1 Discovery.
 */
export interface PatternCatalogEntry {
  id: string;
  name: string;
  description: string;
  industry: string;
  typicalDataTypes: string[];
  typicalIngestionRate: string;
  typicalVectorVolume: string;
  typicalQueryProfile: string;
  typicalLatencyRequirements: string;
  typicalRetrievalMethod: string;
  securityComplianceConsiderations: string[];
  recommendedDesignConsiderations: string[];
  candidateTechnologyCategories: string[];
  validationRequirements: string[];
  defaultAssessment: Partial<DiscoveryAssessmentInput>;
}

export interface DashboardSummary {
  projectId: string;
  projectName: string;
  customerMode: CustomerMode;
  assessmentStatus: PhaseStatus;
  recommendedPlatform: string;
  platformIsManualOverride: boolean;
  vectorCount: number | null;
  datasetSizeBytes: number | null;
  targetQps: number | null;
  targetP95LatencyMs: number | null;
  measuredP95LatencyMs: number | null;
  targetRecallAtK: number | null;
  measuredRecallAtK: number | null;
  capacityUtilizationPercent: number | null;
  risks: string[];
  recommendations: string[];
}

export type Environment = 'development' | 'staging' | 'production';
export type DeploymentEnvironment = 'cloud' | 'on_premises' | 'hybrid';
export type OperationalCapability = 'none' | 'part_time' | 'dedicated_dba' | 'platform_team';
export type TenancyModel = 'single_tenant' | 'shared_multi_tenant' | 'dedicated_per_tenant';
export type DataReplicationModel = 'none' | 'active_passive' | 'active_active';
export type QpsScope = 'aggregate' | 'per_region' | 'per_index';
export type SimilarityMetric = 'cosine' | 'dot_product' | 'euclidean';

export interface DiscoveryAssessmentInput {
  environment: Environment;
  documentCount: number;
  documentGrowthPercentPerMonth: number;
  avgDocumentSizeKb: number;
  chunksPerDocument: number;
  estimatedVectorCount: number;
  embeddingDimension: number;
  similarityMetric: SimilarityMetric;
  qps: number;
  peakQps: number;
  qpsScope: QpsScope;
  concurrentUsers: number;
  targetP95LatencyMs: number;
  targetP99LatencyMs: number;
  availabilityTargetPercent: number;
  rpoMinutes: number;
  rtoMinutes: number;
  retentionDays: number;
  requiresSimilaritySearch: boolean;
  requiresSemanticSearch: boolean;
  requiresHybridSearch: boolean;
  requiresMetadataFiltering: boolean;
  requiresFullTextSearch: boolean;
  topK: number;
  recallTarget: number;
  precisionTarget?: number;
  ndcgTarget?: number;
  mrrTarget?: number;
  requiresReranking: boolean;
  hasExistingOracle: boolean;
  hasExistingPostgres: boolean;
  hasExistingKubernetes: boolean;
  existingPlatforms: string[];
  deploymentEnvironment: DeploymentEnvironment;
  availableCpuCores: number;
  availableRamGb: number;
  availableStorageGb: number;
  hasGpu: boolean;
  operationalCapability: OperationalCapability;
  monthlyBudgetUsd?: number;
  requiresMultiRegion: boolean;
  deploymentRegionCount?: number;
  trafficDistributionPercent?: string;
  dataReplicationModel: DataReplicationModel;
  regionalFailoverRequired: boolean;
  crossRegionReplicationRequired: boolean;
  tenancyModel: TenancyModel;
  requiresAuthentication: boolean;
  requiresRbac: boolean;
  requiresEncryptionAtRest: boolean;
  requiresEncryptionInTransit: boolean;
  requiresKeyManagement: boolean;
  requiresTenantIsolation: boolean;
  requiresAuditLogging: boolean;
  dataResidencyRequirement?: string;
  containsPii: boolean;
  regulatoryRequirements?: string;
}

export interface DiscoveryAssessment extends DiscoveryAssessmentInput {
  id: string;
  version: number;
  createdAt: string;
}

export interface CriteriaScores {
  vectorCount: number;
  qps: number;
  latency: number;
  recall: number;
  existingPlatform: number;
  operationalComplexity: number;
  cost: number;
}

export type EligibilityStatus = 'eligible' | 'unverified' | 'ineligible';

export interface ScoredOption {
  platformId: string;
  label: string;
  totalScore: number;
  criteriaScores: CriteriaScores;
  evidence: string[];
  eligibilityStatus: EligibilityStatus;
  eligibilityNotes: string[];
}

export type AlternativeBucket = 'tied' | 'strong' | 'lower_fit' | 'capacity_constraint';

export interface RankedAlternative {
  platformId: string;
  reason: string;
  bucket: AlternativeBucket;
}

export type DecisionStatus = 'single' | 'tied' | 'conditional';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface BudgetFeasibility {
  monthlyBudgetUsd: number;
  status: 'within_budget' | 'exceeds_budget' | 'not_yet_estimated';
  estimatedMonthlyCostUsd: number | null;
  note: string;
}

export interface ComplianceCheck {
  control: string;
  satisfied: boolean;
}

export interface ComplianceGateResult {
  applicable: boolean;
  status: 'not_applicable' | 'passed' | 'unverified';
  checks: ComplianceCheck[];
}

export interface InfrastructureEstimate {
  estimatedRawVectorGb: number;
  estimatedMemoryGb: number;
  estimatedStorageGb: number;
  estimatedCpuCores: number;
  notes: string[];
}

export type FitRating = 'great' | 'ok' | 'weak';

export interface PlainLanguageScorecardRow {
  label: string;
  rating: FitRating;
  explanation: string;
}

export interface PlainLanguageSummary {
  verdict: 'Excellent Fit' | 'Good Fit' | 'Workable Fit' | 'Weak Fit';
  conditionalBadge: string | null;
  headline: string;
  scorecard: PlainLanguageScorecardRow[];
  costAndEffort: string;
  risks: string[];
  bottomLine: string;
}

export type RiskCategory =
  | 'performance'
  | 'scalability'
  | 'security'
  | 'compliance'
  | 'availability'
  | 'cost'
  | 'migration'
  | 'data_quality'
  | 'search_quality'
  | 'vendor_platform'
  | 'operations';
export type RiskSeverity = 'low' | 'medium' | 'high';
export type RiskStatus = 'open' | 'mitigated' | 'accepted' | 'closed';

export interface RiskEntry {
  id: string;
  category: RiskCategory;
  description: string;
  impact: RiskSeverity;
  likelihood: RiskSeverity;
  mitigation: string;
  owner?: string;
  status: RiskStatus;
  validationRequired: boolean;
}

export type AssumptionType = 'customer_provided' | 'architect_provided' | 'pattern_default' | 'calculated' | 'directional' | 'unknown';
export type AssumptionConfidence = 'high' | 'medium' | 'low';

export interface AssumptionEntry {
  id: string;
  parameter: string;
  value: string;
  source: string;
  type: AssumptionType;
  confidence: AssumptionConfidence;
  impact: string;
  validationRequired: boolean;
}

export interface ArchitectureDecisionRecord {
  id: string;
  rulesVersion: string;
  decision: string;
  rationale: string;
  options: ScoredOption[];
  rejectedAlternatives: RankedAlternative[];
  assumptions: AssumptionEntry[];
  risks: RiskEntry[];
  infrastructureEstimate: InfrastructureEstimate;
  operationalComplexity: string;
  plainLanguageSummary: PlainLanguageSummary | null;
  criteriaWeights: CriteriaScores | null;
  decisionStatus: DecisionStatus;
  confidence: ConfidenceLevel;
  tiedPlatformIds: string[];
  tieBreakStage: string | null;
  openValidations: string[];
  budgetFeasibility: BudgetFeasibility | null;
  complianceGate: ComplianceGateResult | null;
  createdAt: string;
}

export interface DiscoveryOutcome {
  assessment: DiscoveryAssessment;
}

/** Phase 4 - Vector DB Selection & Target Architecture. */
export interface VectorDbSelectionOutcome {
  adr: ArchitectureDecisionRecord;
}

export interface SensitivityResult {
  scenario: string;
  decision: string;
  decisionChanged: boolean;
  totalScore: number;
  decisionStatus: DecisionStatus;
}

export interface SensitivityAnalysis {
  baselineDecision: string;
  baselineDecisionStatus: DecisionStatus;
  scenarios: SensitivityResult[];
}

export type ChunkingStrategy =
  | 'fixed_size'
  | 'token_based'
  | 'sentence_based'
  | 'paragraph_based'
  | 'recursive'
  | 'semantic'
  | 'sliding_window';

export interface ChunkingConfig {
  strategy: ChunkingStrategy;
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize?: number;
  maxChunkSize?: number;
}

export interface ChunkPreview {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  approxTokenCount: number;
}

export interface ChunkingPreviewResult {
  chunks: ChunkPreview[];
  stats: { count: number; avgSizeChars: number; minSizeChars: number; maxSizeChars: number };
  notes: string[];
}

export type EmbeddingModelStatus = 'active' | 'deprecated' | 'retired';

export interface EmbeddingModelCatalogEntry {
  id: string;
  label: string;
  dimension: number;
  maxInputTokens: number;
  costPerMillionTokens: number;
  languageSupport: string[];
  qualityTier: string;
  modelVersion: string;
  status: EmbeddingModelStatus;
  region?: string;
  evidence?: string;
  lastVerifiedDate?: string;
}

export interface EmbeddingProviderCatalogEntry {
  id: string;
  label: string;
  models: EmbeddingModelCatalogEntry[];
}

export type MetadataFieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface MetadataField {
  name: string;
  type: MetadataFieldType;
  required?: boolean;
  /** Defaults to true when omitted. */
  filterable?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  description?: string;
}

export type DimensionMismatchReason = 'model_quality_requirement' | 'model_migration' | 'benchmark_result' | 'customer_requirement' | 'other';

export interface DataPipelineDesignInput {
  collectionName: string;
  chunking: ChunkingConfig;
  embeddingProviderId: string;
  embeddingModelId: string;
  metadataFields: MetadataField[];
  dimensionMismatchAcknowledged?: boolean;
  dimensionMismatchReason?: DimensionMismatchReason;
}

/** The formal Phase 2 -> Phase 3 handoff - see GET /projects/:id/data-pipeline/handoff. */
export interface Phase3Handoff {
  vectorCount: number;
  dimension: number;
  metric: SimilarityMetric;
  qps: number;
  peakQps: number;
  topK: number;
  candidateK: number;
  filterUsage: boolean;
  hybridSearch: boolean;
  reranking: boolean;
  targetP95LatencyMs: number;
  recallTarget: number;
  availableMemoryGb: number;
  candidateIndexFamilies: string[];
  status: 'READY' | 'READY_WITH_CONDITIONS' | 'BLOCKED';
  statusReasons: string[];
}

export interface SqlSchemaOutput {
  ddl: string;
  notes: string[];
}

export interface JsonConfigSchemaOutput {
  schema: Record<string, unknown>;
  notes: string[];
}

export interface GeneratedSchemas {
  oracle: SqlSchemaOutput;
  postgres_pgvector: SqlSchemaOutput;
  milvus: JsonConfigSchemaOutput;
  pinecone: JsonConfigSchemaOutput;
  qdrant: JsonConfigSchemaOutput;
  weaviate: JsonConfigSchemaOutput;
  chroma: JsonConfigSchemaOutput;
  elasticsearch: JsonConfigSchemaOutput;
  redis: SqlSchemaOutput;
  mongodb_atlas: JsonConfigSchemaOutput;
  lancedb: JsonConfigSchemaOutput;
  actian: SqlSchemaOutput;
}

/** Human-friendly labels for each GeneratedSchemas key, in the order they should be displayed. */
export const GENERATED_SCHEMA_PLATFORMS: Array<{ key: keyof GeneratedSchemas; label: string }> = [
  { key: 'oracle', label: 'Oracle' },
  { key: 'postgres_pgvector', label: 'PostgreSQL + pgvector' },
  { key: 'milvus', label: 'Milvus' },
  { key: 'pinecone', label: 'Pinecone' },
  { key: 'qdrant', label: 'Qdrant' },
  { key: 'weaviate', label: 'Weaviate' },
  { key: 'chroma', label: 'Chroma' },
  { key: 'elasticsearch', label: 'Elasticsearch / OpenSearch' },
  { key: 'redis', label: 'Redis' },
  { key: 'mongodb_atlas', label: 'MongoDB Atlas Vector Search' },
  { key: 'lancedb', label: 'LanceDB' },
  { key: 'actian', label: 'Actian Vector' },
];

export interface PipelineStage {
  name: string;
  description: string;
}

export interface PipelineErrorHandling {
  retryCount: number;
  retryBackoffMs: number;
  deadLetterEnabled: boolean;
  batchSize: number;
  monitoringMetrics: string[];
}

export interface DataPipelineExecutiveSummary {
  headline: string;
  scorecard: PlainLanguageScorecardRow[];
  costAndEffort: string;
  considerations: string[];
  bottomLine: string;
}

export interface DataPipelineDesign extends DataPipelineDesignInput {
  id: string;
  version: number;
  chunkingStrategy: ChunkingStrategy;
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize?: number;
  maxChunkSize?: number;
  embeddingDimension: number;
  similarityMetric: SimilarityMetric;
  maxInputTokens: number;
  costPerMillionTokens: number;
  languageSupport: string[];
  qualityTier: string;
  modelVersion: string;
  generatedSchemas: GeneratedSchemas;
  pipelineStages: PipelineStage[];
  errorHandling: PipelineErrorHandling;
  validationWarnings: string[];
  executiveSummary: DataPipelineExecutiveSummary | null;
  createdAt: string;
}

export type UpdateFrequency = 'static' | 'low' | 'moderate' | 'high';
export type IndexType = 'hnsw' | 'ivf_flat' | 'pq';

export interface CreateIndexDesignInput {
  updateFrequency: UpdateFrequency;
  vectorCount?: number;
  dimension?: number;
  availableMemoryGb?: number;
  qps?: number;
  recallTarget?: number;
  targetP95LatencyMs?: number;
  topK?: number;
}

export interface IndexCriteriaScores {
  recall: number;
  latency: number;
  memory: number;
  throughput: number;
  updateFriendliness: number;
}

export interface ScoredIndexOption {
  indexType: IndexType;
  label: string;
  totalScore: number;
  criteriaScores: IndexCriteriaScores;
  estimatedMemoryGb: number;
  evidence: string[];
}

export interface TuningParameter {
  name: string;
  value: number;
  description: string;
}

export interface ImpactEstimate {
  recallEstimate: string;
  latencyEstimate: string;
  memoryEstimateGb: number;
}

export type Phase3HandoffStatus = 'READY' | 'READY_WITH_CONDITIONS' | 'BLOCKED';

/** The Phase 2->3 handoff plus the one genuinely Phase-3-time input (updateFrequency) - what the engine actually used, persisted verbatim. Only the fields also in CreateIndexDesignInput are user-editable overrides; the rest (metric, status, candidateK, ...) are read-only context carried from Phase 1/2. */
export interface IndexDesignInputsUsed {
  vectorCount: number;
  dimension: number;
  availableMemoryGb: number;
  qps: number;
  recallTarget: number;
  targetP95LatencyMs: number;
  topK: number;
  updateFrequency: UpdateFrequency;
  metric: SimilarityMetric;
  peakQps: number;
  candidateK: number;
  filterUsage: boolean;
  hybridSearch: boolean;
  reranking: boolean;
  candidateIndexFamilies: IndexType[];
  status: Phase3HandoffStatus;
  statusReasons: string[];
}

export interface IndexDesign {
  id: string;
  version: number;
  rulesVersion: string;
  decision: IndexType;
  label: string;
  rationale: string;
  configuration: TuningParameter[];
  impact: ImpactEstimate;
  scalingConsiderations: string[];
  options: ScoredIndexOption[];
  criteriaWeights: IndexCriteriaScores;
  alternatives: Array<{ indexType: IndexType; reason: string }>;
  updateFrequency: UpdateFrequency;
  inputsUsed: IndexDesignInputsUsed;
  createdAt: string;
}

export interface KubernetesArtifacts {
  namespaceYaml: string;
  secretYaml: string;
  helmValuesYaml: string;
  notes: string[];
}

export interface HealthCheckDefinition {
  description: string;
  check: string;
}

export interface DeploymentPlan {
  id: string;
  version: number;
  platform: 'oracle' | 'postgres_pgvector' | 'milvus';
  collectionName: string;
  sqlScript: string;
  terraform: string;
  kubernetesArtifacts?: KubernetesArtifacts;
  healthCheck: HealthCheckDefinition;
  deploymentChecklist: string[];
  rollbackProcedure: string[];
  executed: boolean;
  executedAt?: string;
  createdAt: string;
}

export interface DeploymentExecutionResult {
  healthCheckPassed: boolean;
  schemaCreated: boolean;
  indexCreated: boolean;
}

export interface DocumentInput {
  id?: string;
  text: string;
  metadata: Record<string, unknown>;
}

export type IngestionRunStatus = 'completed' | 'completed_with_errors' | 'failed';

export interface IngestionMetrics {
  documentsSubmitted: number;
  documentsCorrupted: number;
  chunksProduced: number;
  chunksEmbedded: number;
  chunksDeduplicated: number;
  chunksStored: number;
  chunksDeadLettered: number;
  durationMs: number;
}

export interface IngestionRun {
  id: string;
  version: number;
  status: IngestionRunStatus;
  collectionName: string;
  configUsed: {
    batchSize: number;
    embeddingConcurrency: number;
    retryCount: number;
    retryBackoffMs: number;
    rateLimitPerSecond: number;
  };
  metrics: IngestionMetrics;
  createdAt: string;
}

export interface DeadLetterRecord {
  id: string;
  documentId?: string;
  chunkIndex?: number;
  reason: string;
  payloadSnapshot: Record<string, unknown>;
  reprocessed: boolean;
  createdAt: string;
}

export interface RetryDeadLettersResult {
  reprocessed: number;
  stillFailed: number;
}

export interface VariantResult {
  searchParamName: string;
  searchParamValue: number;
  isBaseline: boolean;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgRecall: number;
  achievedQps: number;
}

export interface OptimizationReport {
  id: string;
  version: number;
  indexType: IndexType;
  baselineConfiguration: TuningParameter[];
  sampleSize: number;
  queryCount: number;
  topK: number;
  variantResults: VariantResult[];
  recommendedVariant: VariantResult;
  bottlenecks: string[];
  beforeAfterComparison: { baseline: VariantResult; recommended: VariantResult };
  capacityImpact: { estimatedMemoryGb: number };
  costImplications: { estimatedCostPerHourUsd: number };
  createdAt: string;
}

export interface CreateBenchmarkInput {
  sampleSize?: number;
  queryCount?: number;
  topK?: number;
  variants?: number[];
}

export interface ResourceEstimate {
  vectorCount: number;
  qps: number;
  memoryGb: number;
  storageGb: number;
  cpuCores: number;
}

export interface HorizonForecast {
  horizonMonths: number;
  projectedVectorCount: number;
  projectedQps: number;
  estimatedMemoryGb: number;
  estimatedStorageGb: number;
  estimatedCpuCores: number;
  scalingTriggersHit: string[];
}

export interface ShardingRecommendation {
  strategy: string;
  details: string[];
}

export interface CapacityPlan {
  id: string;
  version: number;
  platform: string;
  indexType: IndexType;
  currentState: ResourceEstimate;
  forecast: HorizonForecast[];
  shardingRecommendation: ShardingRecommendation;
  haRecommendation: string[];
  drRecommendation: string[];
  recommendedInfrastructure: string[];
  createdAt: string;
}

export interface CreateCapacityPlanInput {
  currentVectorCount?: number;
  currentQps?: number;
  availableMemoryGb?: number;
  availableCpuCores?: number;
  availableStorageGb?: number;
  monthlyGrowthPercent?: number;
}

export type ReportType = 'discovery' | 'vector-db-selection' | 'data-pipeline' | 'index-design' | 'deployment-plan' | 'optimization-report' | 'capacity-plan' | 'complete';
export type ReportFormat = 'pdf' | 'docx';

export interface AuditLogEntry {
  id: string;
  userEmail?: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSummary?: unknown;
  responseSummary?: unknown;
  createdAt: string;
}
