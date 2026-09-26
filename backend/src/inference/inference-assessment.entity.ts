import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { InferenceAssessmentResult, InferenceDecision, InferenceEngineInput } from './inference.types';
import { CreateInferenceAssessmentDto } from './dto/create-inference-assessment.dto';

/**
 * Inference Assessment. Versioned per project like the vector
 * track's deliverables (a changed input produces a new row, never an edit),
 * but stored in its own table and never touches the vector phase statuses.
 */
@Entity({ name: 'inference_assessments' })
export class InferenceAssessment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  /** Exactly what the user submitted - kept for audit and to re-open the form. */
  @Column({ type: 'jsonb' })
  submitted: CreateInferenceAssessmentDto;

  /** Inputs after defaults, catalogue lookups, and price overrides were applied. */
  @Column({ type: 'jsonb' })
  inputsUsed: InferenceEngineInput;

  @Column({ type: 'varchar', length: 32 })
  decision: InferenceDecision;

  @Column({ type: 'jsonb' })
  result: InferenceAssessmentResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
