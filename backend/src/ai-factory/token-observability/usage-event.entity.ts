import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { numeric } from './numeric.transformer';

export type ObservedSource = 'simulated' | 'live';
export type RequestStatus = 'success' | 'error';

export interface PriceRef {
  id: string;
  tokenType: string;
  pricePer1M: number;
  effectiveFrom: string;
}

/**
 * Normalized AI usage event (spec §10). One row per LLM, embedding, rerank,
 * tool or agent span. Never holds prompt or response text (spec §18).
 * (project, eventId) is unique so a re-sent batch is not counted twice.
 */
@Entity({ name: 'ai_usage_events' })
@Unique(['project', 'eventId'])
@Index(['project', 'timestamp'])
@Index(['project', 'traceId'])
@Index(['project', 'telemetrySource', 'timestamp'])
@Index(['project', 'simulationRunId'])
export class AiUsageEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  project: Project;

  @Column()
  eventId: string;

  @Column({ type: 'timestamptz' })
  timestamp: Date;

  @Column({ type: 'varchar', nullable: true }) requestId: string | null;
  @Column({ type: 'varchar', nullable: true }) traceId: string | null;
  @Column({ type: 'varchar', nullable: true }) spanId: string | null;
  /** Links spans into the agent → LLM → tool → LLM tree (spec §9). */
  @Column({ type: 'varchar', nullable: true }) parentSpanId: string | null;

  @Column({ type: 'varchar', nullable: true }) tenantId: string | null;
  @Column({ type: 'varchar', nullable: true }) applicationId: string | null;
  @Column({ type: 'varchar', nullable: true }) serviceId: string | null;
  @Column({ type: 'varchar', nullable: true }) workflowId: string | null;
  @Column({ type: 'varchar', nullable: true }) agentId: string | null;
  @Column({ type: 'varchar', nullable: true }) sessionId: string | null;

  @Column() provider: string;
  @Column() model: string;
  @Column({ type: 'varchar', nullable: true }) modelVersion: string | null;
  /** chat, text_completion, embeddings, rerank, execute_tool, invoke_agent (OTel gen_ai.operation.name). */
  @Column() operationType: string;
  /** Spec §7 RAG stage: query_embedding, retrieval, rerank, generation. */
  @Column({ type: 'varchar', nullable: true }) ragStage: string | null;
  /** Spec §7 Tool / API. */
  @Column({ type: 'varchar', nullable: true }) toolName: string | null;

  @Column({ type: 'varchar', nullable: true }) environment: string | null;
  @Column({ type: 'varchar', nullable: true }) region: string | null;

  @Column({ type: 'int', default: 0 }) inputTokens: number;
  @Column({ type: 'int', default: 0 }) outputTokens: number;
  @Column({ type: 'int', nullable: true }) reasoningTokens: number | null;
  @Column({ type: 'int', nullable: true }) cachedInputTokens: number | null;
  @Column({ type: 'int', default: 0 }) totalTokens: number;
  @Column({ type: 'int', default: 0 }) embeddingTokens: number;
  @Column({ type: 'int', default: 0 }) rerankingTokens: number;
  @Column({ type: 'int', default: 0 }) contextTokens: number;

  @Column({ type: 'int', default: 0 }) retrievalCount: number;
  @Column({ type: 'int', default: 0 }) toolCallCount: number;
  @Column({ type: 'int', default: 0 }) llmCallCount: number;

  @Column({ type: 'int', nullable: true }) latencyMs: number | null;
  @Column({ type: 'int', nullable: true }) ttftMs: number | null;
  @Column({ type: 'varchar', length: 16, default: 'success' }) requestStatus: RequestStatus;
  @Column({ type: 'varchar', nullable: true }) errorType: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: numeric }) estimatedInputCost: number | null;
  @Column({ type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: numeric }) estimatedOutputCost: number | null;
  @Column({ type: 'numeric', precision: 18, scale: 8, nullable: true, transformer: numeric }) estimatedTotalCost: number | null;
  @Column({ type: 'varchar', length: 3, nullable: true }) currency: string | null;
  /** The price rows the cost was computed from, so it can be explained later (spec §13). */
  @Column({ type: 'jsonb', default: () => "'[]'" }) priceRefs: PriceRef[];

  @Column({ type: 'varchar', length: 16 })
  telemetrySource: ObservedSource;

  /** Set for events that came from an uploaded load-test or benchmark result (ai_simulation_runs). */
  @Column({ type: 'uuid', nullable: true })
  simulationRunId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
