import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { GeneratedSchemas, MetadataFieldDefinition } from '../schema-generator/schema-generator.types';
import { SimilarityMetric } from '../discovery/enums/discovery.enum';
import { DataPipelineExecutiveSummary } from './plain-language-summary';
import { DimensionMismatchReason } from './data-pipeline-design.types';

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

/**
 * Phase 2 deliverable: the Data Pipeline Design
 * (Source -> Extract -> Clean -> Chunk -> Embed -> Validate -> Store -> Index).
 * Versioned per project like DiscoveryAssessment - a changed design produces a
 * new row rather than an edit, keeping the history auditable.
 */
@Entity({ name: 'data_pipeline_designs' })
export class DataPipelineDesign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column()
  collectionName: string;

  @Column({ type: 'enum', enum: ChunkingStrategy })
  chunkingStrategy: ChunkingStrategy;

  @Column()
  chunkSize: number;

  @Column()
  chunkOverlap: number;

  @Column({ nullable: true })
  minChunkSize?: number;

  @Column({ nullable: true })
  maxChunkSize?: number;

  @Column()
  embeddingProviderId: string;

  @Column()
  embeddingModelId: string;

  @Column()
  embeddingDimension: number;

  /** Denormalized from the Discovery assessment at submit time (same pattern as embeddingDimension) - every platform generator reads this instead of assuming cosine. */
  @Column({ type: 'enum', enum: SimilarityMetric, default: SimilarityMetric.COSINE })
  similarityMetric: SimilarityMetric;

  // Nullable: only set when a Discovery/model dimension mismatch was detected and the architect confirmed it was intentional.
  @Column({ type: 'enum', enum: DimensionMismatchReason, nullable: true })
  dimensionMismatchReason?: DimensionMismatchReason | null;

  @Column()
  maxInputTokens: number;

  @Column('float')
  costPerMillionTokens: number;

  @Column({ type: 'jsonb' })
  languageSupport: string[];

  @Column()
  qualityTier: string;

  @Column()
  modelVersion: string;

  @Column({ type: 'jsonb' })
  metadataFields: MetadataFieldDefinition[];

  @Column({ type: 'jsonb' })
  generatedSchemas: GeneratedSchemas;

  @Column({ type: 'jsonb' })
  pipelineStages: PipelineStage[];

  @Column({ type: 'jsonb' })
  errorHandling: PipelineErrorHandling;

  @Column({ type: 'jsonb' })
  validationWarnings: string[];

  // Nullable: designs created before this field existed have no value for it.
  @Column({ type: 'jsonb', nullable: true })
  executiveSummary: DataPipelineExecutiveSummary | null;

  @CreateDateColumn()
  createdAt: Date;
}
