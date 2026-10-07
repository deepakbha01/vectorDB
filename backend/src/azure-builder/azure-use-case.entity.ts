import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { ClassificationDetail, UseCaseSpec } from './use-case-spec';

/**
 * Azure AI Factory Builder - Phase 2 (Use case intake). One immutable version
 * of the UseCaseSpec (spec 6.2). Editing the answers or overriding the pattern
 * creates a new version; every later artifact references a version (spec 4.3).
 */
@Entity({ name: 'azure_builder_use_cases' })
export class AzureUseCase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'jsonb' })
  spec: UseCaseSpec;

  /** The classifier's full output - scores, signals, risk reasons and classifier version. */
  @Column({ type: 'jsonb' })
  classification: ClassificationDetail;

  @CreateDateColumn()
  createdAt: Date;
}
