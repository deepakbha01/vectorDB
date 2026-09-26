import { ValidationPipe } from '@nestjs/common';
import { buildTrace, defaultBucket, growth, growthVsBaseline, previousWindow, resolveFilters, SpanRow, UsageFilters, whereClause, withShare } from './usage-query';
import { UsageQueryDto } from './dto/usage-query.dto';
import { UsageEventBatchDto } from './dto/usage-events.dto';
import { TokenObservabilityController } from './token-observability.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../users/user.entity';
import { TokenObservabilityEnabledGuard } from './token-observability-enabled.guard';

const now = new Date('2026-09-25T12:00:00Z');
// Mirrors main.ts's global pipe so validation is tested exactly as it runs in the app.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

describe('resolveFilters', () => {
  it('defaults to live usage over the last 30 days, bucketed by day', () => {
    const f = resolveFilters({}, now) as UsageFilters;
    expect(f).toEqual({ from: new Date('2026-08-26T12:00:00Z'), to: now, mode: 'live', bucket: 'day', dims: {} });
  });

  it('buckets short ranges by hour and keeps only the filters given', () => {
    const f = resolveFilters({ from: '2026-09-24T00:00:00Z', mode: 'simulated', service: 'claims', model: 'mid' }, now) as UsageFilters;
    expect(f).toEqual(expect.objectContaining({ mode: 'simulated', bucket: 'hour', dims: { service: 'claims', model: 'mid' } }));
  });

  it('picks hour, day or week by range length, and honours week and month when asked (validation spec §6)', () => {
    const day = 86_400_000;
    expect([defaultBucket(2 * day), defaultBucket(30 * day), defaultBucket(180 * day)]).toEqual(['hour', 'day', 'week']);
    expect((resolveFilters({ from: '2026-06-01T00:00:00Z', bucket: 'month' }, now) as UsageFilters).bucket).toBe('month');
    expect((resolveFilters({ bucket: 'week' }, now) as UsageFilters).bucket).toBe('week');
  });

  it.each([
    [{ from: '2026-09-26T00:00:00Z' }, /before/],
    [{ from: '2025-01-01T00:00:00Z' }, /at most 400 days/],
    [{ from: '2026-06-01T00:00:00Z', bucket: 'hour' }, /Hourly trends cover at most 31 days/],
  ])('rejects %p', (q, msg) => {
    expect((resolveFilters(q as UsageQueryDto, now) as { error: string }).error).toMatch(msg);
  });
});

describe('whereClause', () => {
  const f = resolveFilters({ from: '2026-09-25T10:20:00Z', to: '2026-09-25T12:00:00Z', service: 'claims', tenant: 't1' }, now) as UsageFilters;

  it('always scopes to the project and mode, and binds every filter as a parameter', () => {
    const w = whereClause('proj', f, 'events', 'e');
    expect(w.sql).toBe('e."projectId" = $1 AND e."telemetrySource" = $2 AND e."timestamp" >= $3 AND e."timestamp" < $4 AND e."serviceId" = $5 AND e."tenantId" = $6');
    expect(w.params).toEqual(['proj', 'live', new Date('2026-09-25T10:00:00Z'), new Date('2026-09-25T12:00:00Z'), 'claims', 't1']);
  });

  it('starts events and rollups on the same whole hour, so per-request ratios compare like with like', () => {
    const w = whereClause('proj', f, 'rollups', 'r');
    expect(w.sql).toContain('r."bucketStart" >= $3');
    expect(w.params[2]).toEqual(new Date('2026-09-25T10:00:00Z'));
  });
});

describe('baseline and shares', () => {
  it('compares with the preceding window of the same length', () => {
    const f = resolveFilters({ from: '2026-09-20T00:00:00Z', to: '2026-09-25T00:00:00Z' }, now) as UsageFilters;
    expect(previousWindow(f)).toEqual(expect.objectContaining({ from: new Date('2026-09-15T00:00:00Z'), to: new Date('2026-09-20T00:00:00Z') }));
    expect(growth(150, 100)).toBe(50);
    expect(growth(10, 0)).toBeNull();
    expect(withShare([{ totalTokens: 3 }, { totalTokens: 1 }]).map((r) => r.share)).toEqual([75, 25]);
  });
});

describe('buildTrace (spec §9)', () => {
  let t = 0;
  const span = (o: Partial<SpanRow>): SpanRow => ({
    eventId: `s${++t}`,
    timestamp: new Date(Date.UTC(2026, 8, 25, 10, 0, t)),
    spanId: null,
    parentSpanId: null,
    operationType: 'chat',
    provider: 'p',
    model: 'm',
    agentId: 'a1',
    toolName: null,
    ragStage: null,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    embeddingTokens: 0,
    rerankingTokens: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    latencyMs: 500,
    ttftMs: null,
    requestStatus: 'success',
    errorType: null,
    estimatedTotalCost: 0.01,
    ...o,
  });

  it('nests agent → LLM → tool → LLM and totals the trace', () => {
    const rows = [
      span({ spanId: 'agent', operationType: 'invoke_agent', llmCallCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedTotalCost: null }),
      span({ spanId: 'llm1', parentSpanId: 'agent' }),
      span({ spanId: 'tool', parentSpanId: 'agent', operationType: 'execute_tool', toolName: 'search', llmCallCount: 0, toolCallCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedTotalCost: null }),
      span({ spanId: 'llm2', parentSpanId: 'agent' }),
    ];
    const tr = buildTrace(rows, 5);
    expect(tr.roots.map((r) => r.spanId)).toEqual(['agent']);
    expect(tr.roots[0].children.map((c) => c.spanId)).toEqual(['llm1', 'tool', 'llm2']);
    expect(tr.totals).toEqual(expect.objectContaining({ totalTokens: 220, llmCalls: 2, toolCalls: 1, unpricedSpans: 2, errors: 0 }));
    expect(tr.totals.costUsd).toBeCloseTo(0.02);
    expect(tr.loop).toEqual({ threshold: 5, excessiveLlmCalls: false, repeatedTools: [] });
  });

  it('flags excessive LLM calls and repeated tool calls as a possible loop', () => {
    const rows = [
      ...Array.from({ length: 6 }, () => span({})),
      ...Array.from({ length: 3 }, () => span({ operationType: 'execute_tool', toolName: 'lookup', llmCallCount: 0, toolCallCount: 1 })),
    ];
    const tr = buildTrace(rows, 5);
    expect(tr.loop.excessiveLlmCalls).toBe(true);
    expect(tr.loop.repeatedTools).toEqual([{ tool: 'lookup', calls: 3 }]);
  });

  it('shows a partial trace: spans whose parent is missing become roots', () => {
    expect(buildTrace([span({ spanId: 'x', parentSpanId: 'gone' })], 5).roots).toHaveLength(1);
  });
});

describe('UsageEventBatchDto (through the global ValidationPipe) - spec §18', () => {
  const batch = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    telemetrySource: 'live',
    events: [{ eventId: 'e1', timestamp: '2026-09-25T10:00:00Z', provider: 'openai', model: 'gpt-x', operationType: 'chat', inputTokens: 10, ...event }],
    ...extra,
  });
  const parse = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UsageEventBatchDto });

  it('accepts a normalized event', async () => {
    await expect(parse(batch({ serviceId: 'claims-api', model: 'meta-llama/Llama-3.1-8B' }))).resolves.toBeDefined();
  });

  it.each([
    ['a raw prompt field', { prompt: 'What is my diagnosis?' }],
    ['a raw response field', { completion: 'You have ...' }],
    ['free text in a dimension', { serviceId: 'patient John Smith asked about' }],
    ['negative tokens', { inputTokens: -1 }],
    ['an unknown RAG stage', { ragStage: 'everything' }],
  ])('rejects %s', async (_, event) => {
    await expect(parse(batch(event))).rejects.toBeDefined();
  });

  it('rejects estimated usage and oversized batches', async () => {
    await expect(parse(batch({}, { telemetrySource: 'estimated' }))).rejects.toBeDefined();
    const big = { telemetrySource: 'live', events: Array.from({ length: 1001 }, (_, i) => ({ ...batch({}).events[0], eventId: `e${i}` })) };
    await expect(parse(big)).rejects.toBeDefined();
  });
});

describe('TokenObservabilityController RBAC', () => {
  const roles = (m: keyof TokenObservabilityController) => Reflect.getMetadata(ROLES_KEY, TokenObservabilityController.prototype[m]);

  it('lets only admins and architects write (ingest, estimate, prices)', () => {
    for (const m of ['ingest', 'submit', 'addPrice'] as const) expect(roles(m)).toEqual([UserRole.ADMIN, UserRole.ARCHITECT]);
  });

  it('lets every project member read - project access is still checked per request', () => {
    for (const m of ['summary', 'tokens', 'trends', 'services', 'models', 'agents', 'rag', 'cost', 'trace', 'requests', 'dimensions', 'preview', 'latest', 'prices'] as const) expect(roles(m)).toBeUndefined();
  });

  it('puts the feature-flag guard first, so a disabled server reveals nothing', () => {
    expect(Reflect.getMetadata('__guards__', TokenObservabilityController)[0]).toBe(TokenObservabilityEnabledGuard);
  });
});

describe('growthVsBaseline', () => {
  it('withholds growth when the previous period had too little usage to compare', () => {
    expect(growthVsBaseline(3_300_000, 27_000)).toEqual({ percent: null, note: 'too little usage in the previous period to compare' });
    expect(growthVsBaseline(100, 0)).toEqual({ percent: null, note: 'no usage in the previous period' });
    expect(growthVsBaseline(150, 100)).toEqual({ percent: 50, note: null });
  });
});
