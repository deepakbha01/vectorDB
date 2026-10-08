import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { TargetEnv } from './iac-bundle';
import { ValidationReport, WhatIfChange, WhatIfSource } from './validate-approve';

/**
 * Azure AI Factory Builder - Phase 5 (Validate). One what-if for one environment of
 * one IaC bundle (bound by its hash), with the validation report built from it.
 * Kept as evidence for the approval that cites it.
 */
// Column types are spelled out for type-alias fields: under transpile-only builds their reflected
// design type is Object, which TypeORM cannot map.
@Entity({ name: 'azure_builder_what_ifs' })
export class AzureWhatIf {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  iacVersion: number;

  @Column()
  iacHash: string;

  @Column({ type: 'varchar' })
  environment: TargetEnv;

  /** planned: computed offline from the design; arm: pasted from `az deployment group what-if`. */
  @Column({ type: 'varchar' })
  source: WhatIfSource;

  @Column({ type: 'varchar' })
  status: 'succeeded' | 'failed';

  @Column({ type: 'jsonb' })
  changes: WhatIfChange[];

  @Column({ type: 'jsonb' })
  report: ValidationReport;

  @CreateDateColumn()
  createdAt: Date;
}
