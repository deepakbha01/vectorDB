import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { HealthCheckDefinition, KubernetesArtifacts } from './iac-generator.types';

/**
 * Phase 4 deliverable: "Running DB Instance plus IaC, deployment scripts,
 * configuration, health checks, and rollback procedure." This entity is the
 * generated plan/scripts; `execute` (DeploymentPlanController) is the
 * separate, explicit step that actually runs the schema/index creation
 * against the configured target - generating a plan never touches real
 * infrastructure by itself.
 */
@Entity({ name: 'deployment_plans' })
export class DeploymentPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'enum', enum: VectorPlatform })
  platform: VectorPlatform;

  @Column()
  collectionName: string;

  @Column('text')
  sqlScript: string;

  @Column('text')
  terraform: string;

  @Column({ type: 'jsonb', nullable: true })
  kubernetesArtifacts?: KubernetesArtifacts;

  @Column({ type: 'jsonb' })
  healthCheck: HealthCheckDefinition;

  @Column({ type: 'jsonb' })
  deploymentChecklist: string[];

  @Column({ type: 'jsonb' })
  rollbackProcedure: string[];

  @Column({ default: false })
  executed: boolean;

  @Column({ nullable: true })
  executedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;
}
