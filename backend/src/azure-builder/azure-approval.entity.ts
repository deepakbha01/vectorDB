import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { TargetEnv } from './iac-bundle';

/**
 * Azure AI Factory Builder - Phase 5 (Approve). An immutable decision on one
 * environment of one IaC bundle, bound to the bundle's hash (spec 4.6): a later
 * deployment of different bytes is refused. Rows are never updated (a database
 * trigger enforces it); a new decision is a new row.
 */
@Entity({ name: 'azure_builder_approvals' })
export class AzureApproval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  approver: User;

  /** Kept as text so the record stays readable if the user is renamed or removed. */
  @Column()
  approverEmail: string;

  @Column({ type: 'varchar' })
  environment: TargetEnv;

  @Column({ type: 'varchar' })
  decision: 'approved' | 'rejected';

  @Column({ type: 'text', nullable: true })
  comments: string | null;

  @Column()
  iacVersion: number;

  @Column()
  iacHash: string;

  @Column()
  architectureVersion: number;

  @Column()
  useCaseVersion: number;

  @Column()
  whatIfId: string;

  /** What the decision rests on: a real ARM what-if, or the offline plan (the live wave asks for ARM). */
  @Column({ type: 'varchar' })
  evidence: 'arm-what-if' | 'offline-plan';

  /** Responsible-AI checklist items confirmed (required for a high-risk use case, spec 12). */
  @Column({ type: 'jsonb' })
  raiChecklist: string[];

  @CreateDateColumn()
  createdAt: Date;
}
