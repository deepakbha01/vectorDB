import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from 'class-validator';

/**
 * Identifiers and labels only: no spaces, so prompt or response text cannot
 * be smuggled into a dimension (spec §18). Unknown fields such as `prompt`
 * or `completion` are rejected by the global pipe (forbidNonWhitelisted).
 */
const ID = /^[A-Za-z0-9_.:@/+=#-]+$/;
const ID_MESSAGE = '$property must be an identifier (letters, digits and _ . : @ / + = # -), not free text';
const MAX_TOKENS = 100_000_000;

const Id = (max = 200) => (target: object, key: string) => {
  IsOptional()(target, key);
  IsString()(target, key);
  Length(1, max)(target, key);
  Matches(ID, { message: ID_MESSAGE })(target, key);
};
const Count = () => (target: object, key: string) => {
  IsOptional()(target, key);
  IsInt()(target, key);
  Min(0)(target, key);
  Max(MAX_TOKENS)(target, key);
};

/** One normalized usage event (spec §10). */
export class UsageEventDto {
  @IsString()
  @Length(1, 200)
  @Matches(ID, { message: ID_MESSAGE })
  eventId: string;

  @IsISO8601()
  timestamp: string;

  @Id() requestId?: string;
  @Id() traceId?: string;
  @Id() spanId?: string;
  @Id() parentSpanId?: string;

  @Id() tenantId?: string;
  @Id() applicationId?: string;
  @Id() serviceId?: string;
  @Id() workflowId?: string;
  @Id() agentId?: string;
  @Id() sessionId?: string;

  @IsString()
  @Length(1, 100)
  @Matches(ID, { message: ID_MESSAGE })
  provider: string;

  @IsString()
  @Length(1, 200)
  @Matches(ID, { message: ID_MESSAGE })
  model: string;

  @Id(100) modelVersion?: string;

  /** chat, text_completion, generate_content, embeddings, rerank, execute_tool, invoke_agent, ... */
  @IsString()
  @Length(1, 50)
  @Matches(ID, { message: ID_MESSAGE })
  operationType: string;

  @IsOptional()
  @IsIn(['query_embedding', 'retrieval', 'rerank', 'generation'])
  ragStage?: string;

  @Id(100) toolName?: string;
  @Id(100) environment?: string;
  @Id(100) region?: string;

  @Count() inputTokens?: number;
  @Count() outputTokens?: number;
  @Count() reasoningTokens?: number;
  @Count() cachedInputTokens?: number;
  @Count() totalTokens?: number;
  @Count() embeddingTokens?: number;
  @Count() rerankingTokens?: number;
  @Count() contextTokens?: number;
  @Count() retrievalCount?: number;
  @Count() toolCallCount?: number;
  @Count() llmCallCount?: number;
  @Count() latencyMs?: number;
  @Count() ttftMs?: number;

  @IsOptional()
  @IsIn(['success', 'error'])
  requestStatus?: 'success' | 'error';

  @Id(100) errorType?: string;
}

export class UsageEventBatchDto {
  /** Estimated usage is never ingested - it is the phase's own projection. */
  @IsIn(['simulated', 'live'])
  telemetrySource: 'simulated' | 'live';

  @ValidateNested({ each: true })
  @Type(() => UsageEventDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  events: UsageEventDto[];
}
