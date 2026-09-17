import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Project } from '../projects/project.entity';

/**
 * Records the content hash of every chunk successfully stored, scoped to a
 * (project, collection). Checked before embedding/storing a new chunk so
 * re-ingesting the same content - even across separate runs - is skipped
 * rather than duplicated (Phase 5's "Deduplication" / "Prevent: Duplicate
 * vectors" requirements). Per-run idempotency (upsert by the same record ID)
 * is handled separately by the adapters' native upsert.
 */
@Entity({ name: 'ingestion_content_hashes' })
@Unique(['project', 'collectionName', 'contentHash'])
export class IngestionContentHash {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @Column()
  collectionName: string;

  @Column()
  contentHash: string;

  @Column()
  recordId: string;

  @CreateDateColumn()
  createdAt: Date;
}
