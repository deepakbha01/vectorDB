import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';

export interface UploadRejection {
  /** 1-based data row (CSV: excluding the header) or array index + 1 (JSON). */
  row: number;
  eventId: string | null;
  reason: string;
}

/**
 * One uploaded load-test or benchmark result (spec §12 Simulated mode). Its
 * events are stored as simulated usage and carry this run's id, so the whole
 * upload can be removed again without touching live usage or other runs.
 */
@Entity({ name: 'ai_simulation_runs' })
export class AiSimulationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  label: string;

  @Column()
  fileName: string;

  @Column({ type: 'varchar', length: 8 })
  format: 'csv' | 'json';

  @Column({ type: 'int' }) received: number;
  @Column({ type: 'int' }) accepted: number;
  @Column({ type: 'int' }) duplicates: number;
  @Column({ type: 'int' }) rejected: number;
  @Column({ type: 'int' }) unpriced: number;

  @Column({ type: 'timestamptz', nullable: true }) firstEventAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) lastEventAt: Date | null;

  /** The first rejections, with their row numbers, so the file can be fixed. */
  @Column({ type: 'jsonb' })
  rejections: UploadRejection[];

  @CreateDateColumn()
  createdAt: Date;
}
