import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';

/**
 * A persisted, queryable record of every mutating API call - the AUDITABILITY
 * requirement's "User, Timestamp, ... Input changes, Recommendation changes,
 * Deployment actions, Optimization changes, Configuration changes" in one
 * generic shape. Captured once, centrally, by AuditLoggingInterceptor rather
 * than by bespoke calls sprinkled through every service - so no mutating
 * endpoint can be added later without being audited.
 */
@Entity({ name: 'audit_log_entries' })
export class AuditLogEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE', nullable: true })
  @Index()
  project?: Project;

  @ManyToOne(() => User, { nullable: true })
  user?: User;

  @Column({ nullable: true })
  userEmail?: string;

  @Column()
  method: string;

  @Column()
  path: string;

  @Column()
  statusCode: number;

  @Column({ type: 'jsonb', nullable: true })
  requestSummary?: unknown;

  @Column({ type: 'jsonb', nullable: true })
  responseSummary?: unknown;

  @Column()
  durationMs: number;

  @CreateDateColumn()
  createdAt: Date;
}
