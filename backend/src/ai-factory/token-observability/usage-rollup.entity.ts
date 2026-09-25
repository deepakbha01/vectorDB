import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { numeric } from './numeric.transformer';
import { ObservedSource } from './usage-event.entity';

/**
 * Hourly totals of ai_usage_events per attribution key, kept up to date at
 * ingest so dashboards never scan raw events. Missing dimensions are stored
 * as '' (not NULL) so the unique key holds.
 */
@Entity({ name: 'ai_usage_rollups' })
@Unique(['project', 'bucketStart', 'telemetrySource', 'environment', 'tenantId', 'applicationId', 'serviceId', 'workflowId', 'agentId', 'provider', 'model', 'operationType'])
@Index(['project', 'telemetrySource', 'bucketStart'])
export class AiUsageRollup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  project: Project;

  @Column({ type: 'timestamptz' }) bucketStart: Date;
  @Column({ type: 'varchar', length: 16 }) telemetrySource: ObservedSource;
  @Column({ default: '' }) environment: string;
  @Column({ default: '' }) tenantId: string;
  @Column({ default: '' }) applicationId: string;
  @Column({ default: '' }) serviceId: string;
  @Column({ default: '' }) workflowId: string;
  @Column({ default: '' }) agentId: string;
  @Column({ default: '' }) provider: string;
  @Column({ default: '' }) model: string;
  @Column({ default: '' }) operationType: string;

  @Column({ type: 'int', default: 0 }) events: number;
  @Column({ type: 'int', default: 0 }) errors: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) inputTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) outputTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) reasoningTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) cachedInputTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) totalTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) embeddingTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) rerankingTokens: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) contextTokens: number;
  @Column({ type: 'int', default: 0 }) llmCalls: number;
  @Column({ type: 'int', default: 0 }) toolCalls: number;
  @Column({ type: 'bigint', default: 0, transformer: numeric }) latencyMsSum: number;
  @Column({ type: 'numeric', precision: 18, scale: 8, default: 0, transformer: numeric }) costTotal: number;
}
