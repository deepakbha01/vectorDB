import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { IngestionRunStatus } from './enums/ingestion-run-status.enum';
import { IngestionConfig, IngestionMetrics } from './ingestion.types';

/**
 * Phase 5 deliverable: one execution of the ingestion pipeline
 * (Source -> Extract -> Transform -> Chunk -> Embed -> Validate -> Batch ->
 * Insert -> Index). Kept per-run (not edited in place) so metrics and
 * dead-letter records stay attributable to a specific execution.
 */
@Entity({ name: 'ingestion_runs' })
export class IngestionRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'enum', enum: IngestionRunStatus })
  status: IngestionRunStatus;

  @Column()
  collectionName: string;

  @Column({ type: 'jsonb' })
  configUsed: IngestionConfig;

  @Column({ type: 'jsonb' })
  metrics: IngestionMetrics;

  @CreateDateColumn()
  createdAt: Date;
}
