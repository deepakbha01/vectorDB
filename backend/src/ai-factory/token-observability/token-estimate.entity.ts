import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { TokenEstimateResult } from './token-observability.types';

/**
 * Token Observability - the Estimated-mode token and cost projection (spec
 * §12), versioned per project like every other AI Factory deliverable so the
 * phase graph can tell when it is out of date.
 */
@Entity({ name: 'ai_token_estimates' })
export class AiTokenEstimate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  /** What the user overrode (e.g. query or history tokens) - kept to re-open the form. */
  @Column({ type: 'jsonb' })
  submitted: Record<string, unknown>;

  /** The upstream versions and resolved quantities the estimate was built from. */
  @Column({ type: 'jsonb' })
  context: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: TokenEstimateResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
