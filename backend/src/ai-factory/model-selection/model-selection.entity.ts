import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { CreateModelSelectionDto } from './create-model-selection.dto';
import { ModelRequirements, ModelSelectionResult } from './model-selection.types';

/** Model Decision Record (spec §7), versioned per project. */
@Entity({ name: 'ai_model_selections' })
export class AiModelSelection {
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
  submitted: CreateModelSelectionDto;

  /** Requirements after defaults from the Workload Profile. */
  @Column({ type: 'jsonb' })
  requirements: ModelRequirements;

  /** Where each requirement came from (user, Workload Profile, or default). */
  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: ModelSelectionResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
