import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../users/user.entity';
import { VectorPlatform } from './enums/platform.enum';
import { PhaseStatus, ProjectPhase } from './enums/project-status.enum';
import { CustomerMode } from './enums/customer-mode.enum';

export type PhaseStatusMap = Record<ProjectPhase, PhaseStatus>;

function initialPhaseStatuses(): PhaseStatusMap {
  return Object.values(ProjectPhase).reduce((acc, phase) => {
    acc[phase] = PhaseStatus.NOT_STARTED;
    return acc;
  }, {} as PhaseStatusMap);
}

@Entity({ name: 'projects' })
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  businessUseCase?: string;

  @Column({ nullable: true })
  industry?: string;

  /** AI Factory Pattern Library entry id (backend/config/patterns.yaml) this project started from, if any. Always optional - a pattern only seeds defaults, never a hard requirement. */
  @Column({ nullable: true })
  patternId?: string;

  /** New/greenfield vs. existing/modernization (spec S3). Existing-customer technical context lives on the Phase 1 Discovery assessment's existing-technology fields, not here. */
  @Column({ type: 'enum', enum: CustomerMode, default: CustomerMode.NEW })
  customerMode: CustomerMode;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  owner: User;

  @Column({ type: 'enum', enum: VectorPlatform, default: VectorPlatform.UNDETERMINED })
  platform: VectorPlatform;

  @Column({ default: false })
  platformIsManualOverride: boolean;

  @Column({ nullable: true })
  platformDecisionRationale?: string;

  @Column({ type: 'jsonb', default: () => `'${JSON.stringify(initialPhaseStatuses())}'` })
  phaseStatuses: PhaseStatusMap;

  @Column({ default: 1 })
  assessmentVersion: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

export { initialPhaseStatuses };
