import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { DeploymentEnvironment, Environment, OperationalCapability, TenancyModel } from './enums/discovery.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';

/**
 * A single, immutable Phase 1 Discovery submission. Projects may accumulate many
 * of these over time (assessment inputs can change) - `version` and `createdAt`
 * give a full audit trail, and each one has exactly one derived
 * ArchitectureDecisionRecord.
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

  @Column('float')
  qps: number;

  @Column('float')
  peakQps: number;

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

  @Column({ nullable: true })
  dataResidencyRequirement?: string;

  @Column()
  containsPii: boolean;

  @Column({ nullable: true })
  regulatoryRequirements?: string;

  @CreateDateColumn()
  createdAt: Date;
}
