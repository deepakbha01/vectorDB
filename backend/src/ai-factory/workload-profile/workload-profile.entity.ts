import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { CreateWorkloadProfileDto } from './create-workload-profile.dto';
import { ResolvedProfileInputs, WorkloadProfileResult } from './workload-profile.types';

/** AI Workload Profile (spec §4), versioned per project like every other deliverable. */
@Entity({ name: 'ai_workload_profiles' })
export class AiWorkloadProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  /** Exactly what the user entered (re-opens the form). */
  @Column({ type: 'jsonb' })
  submitted: CreateWorkloadProfileDto;

  /** Every value used, with where it came from. */
  @Column({ type: 'jsonb' })
  inputs: ResolvedProfileInputs;

  @Column({ type: 'jsonb' })
  result: WorkloadProfileResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
