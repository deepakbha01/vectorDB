import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { OperationsContext, OperationsResult } from './operations.types';
import { CreateOperationsModelDto } from './create-operations-model.dto';

/** AI Operations Model (spec §14), versioned per project. */
@Entity({ name: 'ai_operations_models' })
export class AiOperationsModel {
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
  submitted: CreateOperationsModelDto;

  @Column({ type: 'jsonb' })
  context: OperationsContext;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: OperationsResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
