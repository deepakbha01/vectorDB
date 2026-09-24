import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { UpdateFrequency } from '../index-recommendation-engine/enums/update-frequency.enum';
import {
  ImpactEstimate,
  IndexCriteriaScores,
  ScoredIndexOption,
  TuningParameter,
} from '../index-recommendation-engine/index-recommendation.types';
import { Phase2Handoff } from '../data-pipeline/data-pipeline-design.types';

/** The Phase 2->3 handoff plus the one genuinely Phase-3-time input (updateFrequency) - what actually gets fed to the engine and persisted. */
export type IndexDesignInputs = Phase2Handoff & { updateFrequency: UpdateFrequency };

/**
 * Phase 3 deliverable: the Indexing Strategy Guide produced by the Index
 * Recommendation Engine. Versioned per project like the other phase
 * deliverables - a changed input produces a new row, keeping history
 * reproducible from (inputs, rulesVersion).
 */
@Entity({ name: 'index_designs' })
export class IndexDesign {
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
  rulesVersion: string;

  @Column({ type: 'enum', enum: IndexType })
  decision: IndexType;

  @Column()
  label: string;

  @Column('text')
  rationale: string;

  @Column({ type: 'jsonb' })
  configuration: TuningParameter[];

  @Column({ type: 'jsonb' })
  impact: ImpactEstimate;

  @Column({ type: 'jsonb' })
  scalingConsiderations: string[];

  @Column({ type: 'jsonb' })
  options: ScoredIndexOption[];

  @Column({ type: 'jsonb', nullable: true })
  criteriaWeights: IndexCriteriaScores | null;

  @Column({ type: 'jsonb' })
  alternatives: Array<{ indexType: IndexType; reason: string }>;

  @Column({ type: 'enum', enum: UpdateFrequency })
  updateFrequency: UpdateFrequency;

  @Column({ type: 'jsonb' })
  inputsUsed: IndexDesignInputs;

  @CreateDateColumn()
  createdAt: Date;
}
