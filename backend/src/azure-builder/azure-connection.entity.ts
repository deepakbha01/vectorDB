import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { AzureRole, ConnectionSource, DeploymentModel, ResourceGroupMode } from './azure-builder.enums';
import { EffectivePermissions } from './live-azure';

/**
 * Azure AI Factory Builder - Phase 0 (Connect). The target subscription,
 * resource group and region a project's use case will deploy into. Versioned
 * and immutable: changing the target creates a new version; disconnecting
 * records a version with `active = false`, so the history stays auditable.
 *
 * Holds no credentials or tokens - ever (spec 4.1). In offline mode the role
 * is declared by the user (`source = declared`); a live connection reads it
 * from Azure with the user's sign-in (`source = live`).
 */
@Entity({ name: 'azure_builder_connections' })
export class AzureConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ default: true })
  active: boolean;

  @Column({ type: 'varchar', length: 16 })
  source: ConnectionSource;

  @Column({ type: 'varchar', length: 36 })
  tenantId: string;

  @Column({ type: 'varchar', length: 36 })
  subscriptionId: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  subscriptionName: string | null;

  @Column({ type: 'varchar', length: 90 })
  resourceGroup: string;

  @Column({ type: 'varchar', length: 16 })
  resourceGroupMode: ResourceGroupMode;

  @Column({ type: 'varchar', length: 40 })
  region: string;

  @Column({ type: 'varchar', length: 24 })
  deploymentModel: DeploymentModel;

  @Column({ type: 'varchar', length: 16 })
  role: AzureRole;

  /** Live only: the effective permissions Azure reported on the target scope when the connection was verified. */
  @Column({ type: 'jsonb', nullable: true })
  permissions: EffectivePermissions | null;

  /** Live only: the Azure account (UPN) that verified the connection - not a credential. */
  @Column({ type: 'varchar', length: 256, nullable: true })
  azureUser: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
