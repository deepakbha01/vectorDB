import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { ArchitectureSpec } from './architecture';

/**
 * Azure AI Factory Builder - Phase 3 (Architect). One immutable ArchitectureSpec
 * version (spec 6.4), with the use case and Environment Profile versions it was
 * designed from, so a newer intake or Discover marks it stale.
 */
@Entity({ name: 'azure_builder_architectures' })
export class AzureArchitecture {
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
  useCaseVersion: number;

  @Column()
  profileVersion: number;

  @Column({ type: 'jsonb' })
  spec: ArchitectureSpec;

  @CreateDateColumn()
  createdAt: Date;
}
