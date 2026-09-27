import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';

/**
 * A project's own connection to its target vector database, replacing the
 * server-wide TARGET_* settings for that project only (ingestion, deployment,
 * benchmarks and the Data Explorer all use it). Settings are stored sealed
 * (AES-256-GCM, CONNECTION_SECRET_KEY); only the names of the settings given
 * are stored in the clear.
 */
@Entity({ name: 'project_connection_profiles' })
export class ProjectConnectionProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn()
  project: Project;

  /** The platform the settings are for; a profile for another platform is ignored. */
  @Column({ type: 'varchar', length: 64 })
  platform: string;

  @Column({ type: 'text' })
  settingsSealed: string;

  /** Which settings are set - names only. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  keysSet: string[];

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  updatedBy: User | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
