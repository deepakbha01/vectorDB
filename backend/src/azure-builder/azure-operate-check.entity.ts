import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { TargetEnv } from './iac-bundle';

export type OperateKind = 'smoke' | 'drift' | 'budget' | 'teardown';
export type OperateStatus = 'passed' | 'failed' | 'warning' | 'info';

/**
 * Azure AI Factory Builder - Phase 7 (Operate). One smoke test, drift check, budget change or
 * teardown request on a deployment, kept as an append-only history (spec 5.3 auditability).
 */
// Column types are spelled out for type-alias fields: under transpile-only builds their reflected
// design type is Object, which TypeORM cannot map.
@Entity({ name: 'azure_builder_operate_checks' })
export class AzureOperateCheck {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  createdByEmail: string;

  @Column()
  deploymentId: string;

  @Column({ type: 'varchar' })
  environment: TargetEnv;

  @Column({ type: 'varchar', length: 16 })
  kind: OperateKind;

  @Column({ type: 'varchar', length: 16 })
  status: OperateStatus;

  @Column({ type: 'text' })
  summary: string;

  /** The checks, drift items or budget settings behind the summary. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  result: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
