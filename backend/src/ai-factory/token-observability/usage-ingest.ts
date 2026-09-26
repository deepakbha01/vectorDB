import { costOf, PriceRow, PricingTreatment } from './pricing';
import { ObservedSource, PriceRef, RequestStatus } from './usage-event.entity';
import { UsageEventDto } from './dto/usage-events.dto';

/**
 * Normalizing and pricing usage events - pure, no I/O.
 *
 * Conventions (match OpenTelemetry GenAI usage attributes):
 * - inputTokens include cachedInputTokens; outputTokens include reasoningTokens.
 * - embeddings / rerank calls report their tokens as input; they are moved to
 *   embeddingTokens / rerankingTokens so LLM input totals stay LLM-only.
 * - totalTokens defaults to input + output (LLM tokens).
 */

export const LLM_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content']);
const EMBEDDING_OPERATIONS = new Set(['embeddings', 'embedding']);
const RERANK_OPERATIONS = new Set(['rerank']);
const TOOL_OPERATIONS = new Set(['execute_tool']);

export interface NormalizedEvent {
  eventId: string;
  timestamp: Date;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  tenantId: string | null;
  applicationId: string | null;
  serviceId: string | null;
  workflowId: string | null;
  agentId: string | null;
  sessionId: string | null;
  provider: string;
  model: string;
  modelVersion: string | null;
  operationType: string;
  ragStage: string | null;
  toolName: string | null;
  environment: string | null;
  region: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number;
  embeddingTokens: number;
  rerankingTokens: number;
  contextTokens: number;
  retrievalCount: number;
  toolCallCount: number;
  llmCallCount: number;
  latencyMs: number | null;
  ttftMs: number | null;
  requestStatus: RequestStatus;
  errorType: string | null;
  estimatedInputCost: number | null;
  estimatedOutputCost: number | null;
  estimatedTotalCost: number | null;
  currency: string | null;
  priceRefs: PriceRef[];
  telemetrySource: ObservedSource;
  simulationRunId: string | null;
}

export interface Rejection {
  eventId: string;
  reason: string;
}

/** How far ahead of the server clock an event may be stamped (clock skew). */
const MAX_FUTURE_MS = 5 * 60_000;

export function normalizeEvent(
  e: UsageEventDto,
  source: ObservedSource,
  prices: PriceRow[],
  projectId: string,
  treatment: Pick<PricingTreatment, 'cachedInputPriceFactor' | 'reasoningBilledAs'>,
  now: Date,
): NormalizedEvent | Rejection {
  const timestamp = new Date(e.timestamp);
  if (timestamp.getTime() > now.getTime() + MAX_FUTURE_MS) return { eventId: e.eventId, reason: 'timestamp is in the future' };
  const op = e.operationType.toLowerCase();
  let input = e.inputTokens ?? 0;
  let embedding = e.embeddingTokens ?? 0;
  let reranking = e.rerankingTokens ?? 0;
  if (EMBEDDING_OPERATIONS.has(op) && !embedding) [embedding, input] = [input, 0];
  if (RERANK_OPERATIONS.has(op) && !reranking) [reranking, input] = [input, 0];
  const output = e.outputTokens ?? 0;
  const cached = e.cachedInputTokens ?? null;
  const reasoning = e.reasoningTokens ?? null;
  if ((cached ?? 0) > input) return { eventId: e.eventId, reason: 'cachedInputTokens exceed inputTokens (cached tokens are part of input)' };
  if ((reasoning ?? 0) > output) return { eventId: e.eventId, reason: 'reasoningTokens exceed outputTokens (reasoning tokens are part of output)' };

  // Priced at the price in force when the call happened - later price changes never rewrite this.
  const c = costOf(prices, e.provider, e.model, { input, output, cachedInput: cached, reasoning, embedding, reranking }, timestamp, projectId, treatment);

  return {
    eventId: e.eventId,
    timestamp,
    requestId: e.requestId ?? null,
    traceId: e.traceId ?? null,
    spanId: e.spanId ?? null,
    parentSpanId: e.parentSpanId ?? null,
    tenantId: e.tenantId ?? null,
    applicationId: e.applicationId ?? null,
    serviceId: e.serviceId ?? null,
    workflowId: e.workflowId ?? null,
    agentId: e.agentId ?? null,
    sessionId: e.sessionId ?? null,
    provider: e.provider,
    model: e.model,
    modelVersion: e.modelVersion ?? null,
    operationType: op,
    ragStage: e.ragStage ?? null,
    toolName: e.toolName ?? null,
    environment: e.environment ?? null,
    region: e.region ?? null,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedInputTokens: cached,
    totalTokens: e.totalTokens ?? input + output,
    embeddingTokens: embedding,
    rerankingTokens: reranking,
    contextTokens: e.contextTokens ?? 0,
    retrievalCount: e.retrievalCount ?? 0,
    toolCallCount: e.toolCallCount ?? (TOOL_OPERATIONS.has(op) ? 1 : 0),
    llmCallCount: e.llmCallCount ?? (LLM_OPERATIONS.has(op) ? 1 : 0),
    latencyMs: e.latencyMs ?? null,
    ttftMs: e.ttftMs ?? null,
    requestStatus: e.requestStatus ?? (e.errorType ? 'error' : 'success'),
    errorType: e.errorType ?? null,
    estimatedInputCost: c.inputCost,
    estimatedOutputCost: c.outputCost,
    estimatedTotalCost: c.totalCost,
    currency: c.currency,
    priceRefs: c.refs,
    telemetrySource: source,
    simulationRunId: null,
  };
}

export const isRejection = (x: NormalizedEvent | Rejection): x is Rejection => 'reason' in x;

export const ROLLUP_DIMENSIONS = ['environment', 'tenantId', 'applicationId', 'serviceId', 'workflowId', 'agentId', 'provider', 'model', 'operationType'] as const;
export const ROLLUP_MEASURES = ['events', 'errors', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens', 'totalTokens', 'embeddingTokens', 'rerankingTokens', 'contextTokens', 'llmCalls', 'toolCalls', 'latencyMsSum', 'costTotal'] as const;

export type RollupDelta = { bucketStart: Date; telemetrySource: ObservedSource } & Record<(typeof ROLLUP_DIMENSIONS)[number], string> & Record<(typeof ROLLUP_MEASURES)[number], number>;

export const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

/** Hourly totals to add for a set of newly stored events. Missing dimensions become ''. */
export function rollupDeltas(events: NormalizedEvent[]): RollupDelta[] {
  const byKey = new Map<string, RollupDelta>();
  for (const e of events) {
    const bucketStart = hourOf(e.timestamp);
    const dims = Object.fromEntries(ROLLUP_DIMENSIONS.map((k) => [k, (e[k] as string | null) ?? ''])) as Record<(typeof ROLLUP_DIMENSIONS)[number], string>;
    const key = [bucketStart.toISOString(), e.telemetrySource, ...ROLLUP_DIMENSIONS.map((k) => dims[k])].join('\u0000');
    const d =
      byKey.get(key) ??
      ({ bucketStart, telemetrySource: e.telemetrySource, ...dims, ...Object.fromEntries(ROLLUP_MEASURES.map((m) => [m, 0])) } as RollupDelta);
    d.events += 1;
    d.errors += e.requestStatus === 'error' ? 1 : 0;
    d.inputTokens += e.inputTokens;
    d.outputTokens += e.outputTokens;
    d.reasoningTokens += e.reasoningTokens ?? 0;
    d.cachedInputTokens += e.cachedInputTokens ?? 0;
    d.totalTokens += e.totalTokens;
    d.embeddingTokens += e.embeddingTokens;
    d.rerankingTokens += e.rerankingTokens;
    d.contextTokens += e.contextTokens;
    d.llmCalls += e.llmCallCount;
    d.toolCalls += e.toolCallCount;
    d.latencyMsSum += e.latencyMs ?? 0;
    d.costTotal += e.estimatedTotalCost ?? 0;
    byKey.set(key, d);
  }
  // A fixed order (hour, then attribution key) so concurrent batches lock rows in the same order and cannot deadlock.
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, d]) => d);
}
