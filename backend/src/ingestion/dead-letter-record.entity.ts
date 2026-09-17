import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { IngestionRun } from './ingestion-run.entity';

/**
 * A chunk/document that failed to make it into the target database after all
 * retries. Kept so failures are visible and reprocessable (Phase 5's "Failure
 * recovery" / "Dead-letter queue" requirements) instead of silently dropped.
 */
@Entity({ name: 'dead_letter_records' })
export class DeadLetterRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => IngestionRun, { onDelete: 'CASCADE' })
  @Index()
  ingestionRun: IngestionRun;

  @Column({ nullable: true })
  documentId?: string;

  @Column({ nullable: true })
  chunkIndex?: number;

  @Column('text')
  reason: string;

  @Column({ type: 'jsonb' })
  payloadSnapshot: Record<string, unknown>;

  @Column({ default: false })
  reprocessed: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
