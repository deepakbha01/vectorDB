import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { AssessmentState, PhaseLineage } from './ai-factory.types';

/**
 * A saved copy of the central assessment state (spec §23) so assessment runs
 * can be compared over time. Written only when a user saves a snapshot; the
 * live state is always rebuilt from the phase deliverables.
 */
@Entity({ name: 'ai_factory_state_snapshots' })
export class AiFactoryStateSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'varchar', length: 120, nullable: true })
  label: string | null;

  @Column({ type: 'jsonb' })
  state: AssessmentState;

  @Column({ type: 'jsonb' })
  lineage: PhaseLineage[];

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
