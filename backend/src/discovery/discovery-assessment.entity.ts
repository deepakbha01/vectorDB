import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import {
  ContentChangeFrequency,
  ContentModality,
  DataReplicationModel,
  DeploymentEnvironment,
  DocumentStructure,
  Environment,
  ExplainabilityNeed,
  OperationalCapability,
  QpsScope,
  SimilarityMetric,
  TenancyModel,
} from './enums/discovery.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';

/**
 * A single, immutable Phase 1 Discovery submission. Projects may accumulate many
 * of these over time (assessment inputs can change) - `version` and `createdAt`
 * give a full audit trail. Once Phases 2-3 are also complete, Phase 4 (Vector DB
 * Selection) can derive an ArchitectureDecisionRecord from the latest one.
 */
@Entity({ name: 'discovery_assessments' })
export class DiscoveryAssessment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  submittedBy: User;

  @Column()
  version: number;

  @Column({ type: 'enum', enum: Environment })
  environment: Environment;

  @Column()
  documentCount: number;

  @Column('float')
  documentGrowthPercentPerMonth: number;

  @Column('float')
  avgDocumentSizeKb: number;

  @Column()
  chunksPerDocument: number;

  @Column()
  estimatedVectorCount: number;

  @Column()
  embeddingDimension: number;

  /** Drives Phase 2/3 schema and index generation - every platform generator reads this instead of assuming cosine. */
  @Column({ type: 'enum', enum: SimilarityMetric, default: SimilarityMetric.COSINE })
  similarityMetric: SimilarityMetric;

  @Column('float')
  qps: number;

  @Column('float')
  peakQps: number;

  @Column({ type: 'enum', enum: QpsScope, default: QpsScope.AGGREGATE })
  qpsScope: QpsScope;

  @Column()
  concurrentUsers: number;

  @Column('float')
  targetP95LatencyMs: number;

  /** Defaults to 0 ("not recorded") for assessments submitted before this field existed. */
  @Column('float', { default: 0 })
  targetP99LatencyMs: number;

  @Column('float')
  availabilityTargetPercent: number;

  @Column()
  rpoMinutes: number;

  @Column()
  rtoMinutes: number;

  @Column()
  retentionDays: number;

  @Column()
  requiresSimilaritySearch: boolean;

  @Column()
  requiresSemanticSearch: boolean;

  @Column()
  requiresHybridSearch: boolean;

  @Column()
  requiresMetadataFiltering: boolean;

  @Column()
  requiresFullTextSearch: boolean;

  @Column()
  topK: number;

  @Column('float')
  recallTarget: number;

  @Column('float', { nullable: true })
  precisionTarget?: number;

  @Column({ default: false })
  requiresReranking: boolean;

  @Column('float', { nullable: true })
  ndcgTarget?: number;

  @Column('float', { nullable: true })
  mrrTarget?: number;

  @Column()
  hasExistingOracle: boolean;

  @Column()
  hasExistingPostgres: boolean;

  @Column()
  hasExistingKubernetes: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  existingPlatforms: VectorPlatform[];

  @Column({ type: 'enum', enum: DeploymentEnvironment })
  deploymentEnvironment: DeploymentEnvironment;

  @Column('float')
  availableCpuCores: number;

  @Column('float')
  availableRamGb: number;

  @Column('float')
  availableStorageGb: number;

  @Column()
  hasGpu: boolean;

  @Column({ type: 'enum', enum: OperationalCapability, default: OperationalCapability.NONE })
  operationalCapability: OperationalCapability;

  @Column('float', { nullable: true })
  monthlyBudgetUsd?: number;

  @Column({ default: false })
  requiresMultiRegion: boolean;

  @Column({ nullable: true })
  deploymentRegionCount?: number;

  @Column({ nullable: true })
  trafficDistributionPercent?: string;

  @Column({ type: 'enum', enum: DataReplicationModel, default: DataReplicationModel.NONE })
  dataReplicationModel: DataReplicationModel;

  @Column({ default: false })
  regionalFailoverRequired: boolean;

  @Column({ default: false })
  crossRegionReplicationRequired: boolean;

  @Column({ type: 'enum', enum: TenancyModel, default: TenancyModel.SINGLE_TENANT })
  tenancyModel: TenancyModel;

  @Column()
  requiresAuthentication: boolean;

  @Column()
  requiresRbac: boolean;

  @Column()
  requiresEncryptionAtRest: boolean;

  @Column()
  requiresEncryptionInTransit: boolean;

  @Column({ default: false })
  requiresKeyManagement: boolean;

  @Column({ default: false })
  requiresTenantIsolation: boolean;

  @Column({ default: false })
  requiresAuditLogging: boolean;

  @Column({ nullable: true })
  dataResidencyRequirement?: string;

  @Column()
  containsPii: boolean;

  @Column({ nullable: true })
  regulatoryRequirements?: string;

  // ---- Retrieval Strategy Assessment (all optional) ----
  // Stored as plain strings rather than Postgres enum types, so adding a value
  // later needs no type migration. The assessment runs only when a query mix
  // is given; with every field blank, Phase 4 behaves exactly as before.

  @Column({ type: 'varchar', length: 24, nullable: true })
  documentStructure?: DocumentStructure | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  contentModality?: ContentModality | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  contentChangeFrequency?: ContentChangeFrequency | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  explainabilityNeed?: ExplainabilityNeed | null;

  /** Share of questions (0-100) that use exact terms - IDs, codes, names. */
  @Column('float', { nullable: true })
  queryMixExactPercent?: number | null;

  /** Share of questions (0-100) that need multi-hop reasoning or follow cross-references. */
  @Column('float', { nullable: true })
  queryMixMultiHopPercent?: number | null;

  /** Share of questions (0-100) that are paraphrased / fuzzy semantic. */
  @Column('float', { nullable: true })
  queryMixSemanticPercent?: number | null;

  /** Share of questions (0-100) that aggregate or analyse (better served by text-to-SQL). */
  @Column('float', { nullable: true })
  queryMixAnalyticsPercent?: number | null;

  /** Share of questions (0-100) about relationships between entities (better served by a knowledge graph). */
  @Column('float', { nullable: true })
  queryMixRelationshipPercent?: number | null;

  @Column({ default: false })
  isMultilingual: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
