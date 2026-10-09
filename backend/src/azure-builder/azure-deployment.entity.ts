import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { TargetEnv } from './iac-bundle';
import { DenyMode, DeploymentError, DeploymentState } from './live-deploy';

/**
 * Azure AI Factory Builder - Phase 6 (Deploy). One deployment of one environment of an
 * approved IaC bundle as an Azure Deployment Stack (spec 4.7 Mode B), bound to the approved
 * hash. Status is refreshed from ARM while the browser watches (the server holds no token
 * between requests); outputs and resource IDs are kept when it finishes.
 */
// Column types are spelled out for type-alias fields: under transpile-only builds their reflected
// design type is Object, which TypeORM cannot map.
@Entity({ name: 'azure_builder_deployments' })
export class AzureDeployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  deployedBy: User;

  /** Kept as text so the record stays readable if the user is renamed or removed. */
  @Column()
  deployedByEmail: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  azureUser: string | null;

  @Column({ type: 'varchar' })
  environment: TargetEnv;

  @Column()
  iacVersion: number;

  @Column()
  iacHash: string;

  /** The approval this deployment rests on. */
  @Column()
  approvalId: string;

  @Column()
  whatIfId: string;

  @Column({ type: 'varchar', length: 36 })
  subscriptionId: string;

  @Column({ type: 'varchar', length: 90 })
  resourceGroup: string;

  @Column({ type: 'varchar', length: 64 })
  stackName: string;

  @Column({ type: 'text', nullable: true })
  stackId: string | null;

  @Column({ type: 'varchar', length: 16 })
  denyMode: DenyMode;

  @Column({ type: 'varchar', length: 16 })
  state: DeploymentState;

  @Column({ type: 'varchar', length: 40 })
  provisioningState: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  outputs: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  resourceIds: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  errors: DeploymentError[];

  @Column({ type: 'text', nullable: true })
  armDeploymentId: string | null;

  /** Bicep CLI version that compiled the template. */
  @Column({ type: 'varchar', length: 80 })
  compiledWith: string;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastCheckedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
