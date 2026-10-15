import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../users/user.entity';

/**
 * An LLM integration added by an admin in the app (Settings > LLM
 * integrations), used for the optional AI summaries. The API key is stored
 * sealed (AES-256-GCM, CONNECTION_SECRET_KEY) and never returned.
 */
@Entity({ name: 'llm_connections' })
export class LlmConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  /** A key of LLM_PROVIDERS. */
  @Column({ type: 'varchar', length: 40 })
  provider: string;

  /** Model name; for Azure OpenAI, the deployment name. */
  @Column({ type: 'varchar', length: 200 })
  model: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  baseUrl: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  apiVersion: string | null;

  @Column({ type: 'text', nullable: true })
  apiKeySealed: string | null;

  /** Pre-selected on the AI summary card; at most one is the default. */
  @Column({ default: false })
  isDefault: boolean;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  updatedBy: User | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
