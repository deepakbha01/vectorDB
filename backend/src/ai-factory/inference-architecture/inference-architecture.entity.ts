import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { InferenceArchitectureResult, ServingContext } from './inference-architecture.types';
import { CreateInferenceArchitectureDto } from './create-inference-architecture.dto';

/** Inference Architecture Decision Record (spec §8), versioned per project. */
@Entity({ name: 'ai_inference_architectures' })
export class AiInferenceArchitecture {
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
  submitted: CreateInferenceArchitectureDto;

  /** The design inputs, resolved from the inference assessment, Workload Profile, Model Selection and Discovery. */
  @Column({ type: 'jsonb' })
  context: ServingContext;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: InferenceArchitectureResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
