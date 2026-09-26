import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';

/**
 * Machine credential for sending live usage to one project (spec §11, §18).
 * Only a SHA-256 hash of the key is stored; the key itself is shown once, at
 * creation. `prefix` is the non-secret part used to find the row.
 */
@Entity({ name: 'ai_ingest_keys' })
export class AiIngestKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  name: string;

  @Index({ unique: true })
  @Column({ length: 16 })
  prefix: string;

  @Column({ length: 64 })
  keyHash: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
