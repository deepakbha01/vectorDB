import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { ProfileSource } from './azure-builder.enums';
import { EnvironmentConstraints, EnvironmentProfile } from './environment-profile';

/**
 * Azure AI Factory Builder - Phase 1 (Discover). One versioned snapshot of the
 * target subscription (spec 6.3) and the constraints derived from it for the
 * connection's region. Re-scanning creates a new version; earlier ones stay.
 */
@Entity({ name: 'azure_builder_environment_profiles' })
export class AzureEnvironmentProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  /** The connection version this profile was taken for. */
  @Column()
  connectionVersion: number;

  @Column({ type: 'varchar', length: 16 })
  source: ProfileSource;

  @Column({ type: 'jsonb' })
  profile: EnvironmentProfile;

  @Column({ type: 'jsonb' })
  constraints: EnvironmentConstraints;

  /** Rows or inputs that could not be read - reported, never fatal (spec 4.2). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  problems: string[];

  @CreateDateColumn()
  createdAt: Date;
}
