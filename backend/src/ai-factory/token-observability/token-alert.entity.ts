import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import type { AlertRuleKey, AlertSeverity, Firing } from './alerts';

export type AlertStatus = 'open' | 'resolved';

/**
 * A token alert (spec §14). One row per problem (rule + subject): it stays
 * open while the rule keeps firing, and resolves itself when it stops.
 * Acknowledging records that someone is on it; it does not close the alert.
 */
@Entity({ name: 'ai_token_alerts' })
@Index(['project', 'status'])
// At most one OPEN alert per problem; resolved ones are history and may repeat.
@Index('UQ_ai_token_alerts_open_problem', ['project', 'dedupeKey'], { unique: true, where: `"status" = 'open'` })
export class AiTokenAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  project: Project;

  @Column({ type: 'varchar', length: 32 })
  rule: AlertRuleKey;

  @Column({ length: 300 })
  dedupeKey: string;

  @Column({ type: 'varchar', length: 16 })
  severity: AlertSeverity;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status: AlertStatus;

  @Column({ length: 300 })
  title: string;

  @Column({ type: 'text' })
  detail: string;

  @Column({ type: 'jsonb' })
  metric: Firing['metric'];

  @Column({ type: 'timestamptz' })
  firstSeenAt: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @ManyToOne(() => User, { nullable: true })
  acknowledgedBy: User | null;
}
