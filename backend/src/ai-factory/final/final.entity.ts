import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { FinalResult } from './final.types';
import { LineageStatus, PhaseKey } from '../ai-factory.types';

export interface FinalProvenance {
  phases: Array<{ phase: PhaseKey; version: number | null; status: LineageStatus }>;
}

/** Final AI Architecture Recommendation (spec §15-§18, §25, §26), versioned per project. */
@Entity({ name: 'ai_final_recommendations' })
export class AiFinalRecommendation {
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
  submitted: Record<string, never>;

  @Column({ type: 'jsonb' })
  context: FinalProvenance;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: FinalResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
