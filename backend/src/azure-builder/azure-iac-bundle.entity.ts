import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { IacFile, RequiredInput, TargetEnv } from './iac-bundle';
import { EnvInputs, InputName } from './iac-inputs';
import { IacValidation } from './iac-validate';

/**
 * Azure AI Factory Builder - Phase 4 (Generate IaC). One immutable IaC bundle
 * (spec 11.2) generated from an ArchitectureSpec version, with the result of
 * compiling and linting it. Offline the files live here; the live wave adds Blob
 * Storage and a push to GitHub.
 */
@Entity({ name: 'azure_builder_iac_bundles' })
export class AzureIacBundle {
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
  architectureVersion: number;

  @Column()
  workload: string;

  /** Bundle folder name, e.g. uc-1a2b3c4d-hr-policy-assistant. */
  @Column()
  root: string;

  @Column()
  generator: string;

  @Column({ type: 'jsonb' })
  files: IacFile[];

  @Column({ type: 'jsonb' })
  requiredInputs: RequiredInput[];

  @Column({ type: 'jsonb' })
  notes: string[];

  @Column({ type: 'jsonb' })
  validation: IacValidation;

  /** Required-input values per environment, written into the parameter files. */
  @Column({ type: 'jsonb', default: {} })
  inputs: Partial<Record<TargetEnv, EnvInputs>>;

  /** Needed inputs still blank per environment; empty for bundles generated before inputs were tracked. */
  @Column({ type: 'jsonb', default: {} })
  missingInputs: Partial<Record<TargetEnv, InputName[]>>;

  @CreateDateColumn()
  createdAt: Date;
}
