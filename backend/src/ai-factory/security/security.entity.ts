import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { SecurityContext, SecurityResult } from './security.types';
import { CreateSecurityAssessmentDto } from './create-security-assessment.dto';

/** AI Security & Governance Assessment (spec §12), versioned per project. */
@Entity({ name: 'ai_security_assessments' })
export class AiSecurityAssessment {
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
  submitted: CreateSecurityAssessmentDto;

  @Column({ type: 'jsonb' })
  context: SecurityContext;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: SecurityResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
