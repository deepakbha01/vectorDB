import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { PerformanceContext, PerformanceResult } from './performance.types';
import { CreatePerformanceAssessmentDto } from './create-performance-assessment.dto';

/** Performance & Benchmark Assessment (spec §11), versioned per project. */
@Entity({ name: 'ai_performance_assessments' })
export class AiPerformanceAssessment {
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
  submitted: CreatePerformanceAssessmentDto;

  @Column({ type: 'jsonb' })
  context: PerformanceContext;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: PerformanceResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
