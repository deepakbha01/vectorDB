import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiUsageEvent, ObservedSource } from './usage-event.entity';
import { AiTokenEstimate } from './token-estimate.entity';
import { PricingService } from './pricing.service';
import { UsageEventBatchDto } from './dto/usage-events.dto';
import { UsageQueryDto, UsageRequestsQueryDto } from './dto/usage-query.dto';
import { isRejection, normalizeEvent, NormalizedEvent, Rejection, ROLLUP_DIMENSIONS, ROLLUP_MEASURES, rollupDeltas } from './usage-ingest';
import { buildTrace, growth, growthVsBaseline, previousWindow, resolveFilters, SpanRow, UsageFilters, whereClause, withShare } from './usage-query';
import { TelemetryStatus } from './token-observability.types';
import { canSeeTenants } from './privacy';

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const TOKEN_SUMS = `SUM("inputTokens") AS "inputTokens", SUM("outputTokens") AS "outputTokens", SUM("reasoningTokens") AS "reasoningTokens", SUM("cachedInputTokens") AS "cachedInputTokens", SUM("totalTokens") AS "totalTokens", SUM("embeddingTokens") AS "embeddingTokens", SUM("rerankingTokens") AS "rerankingTokens", SUM("contextTokens") AS "contextTokens"`;

export interface IngestResult {
  received: number;
  accepted: number;
  duplicates: number;
  rejected: Rejection[];
  /** Accepted events with tokens but no price in force - their cost is left empty, never guessed. */
  unpriced: number;
}

/**
 * Observed usage (spec §10, §15): ingests normalized usage events and answers
 * the dashboard queries. Simulated and live usage are kept apart by `mode`;
 * estimated usage never comes from here.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly pricing: PricingService,
    @InjectRepository(AiUsageEvent) private readonly events: Repository<AiUsageEvent>,
    @InjectRepository(AiTokenEstimate) private readonly estimates: Repository<AiTokenEstimate>,
  ) {}

  // ---------------------------------------------------------------- ingest
  async ingest(projectId: string, requester: AuthenticatedUser, batch: UsageEventBatchDto, now = new Date()): Promise<IngestResult> {
    await this.projectsService.findOne(projectId, requester);
    const result = await this.ingestForProject(projectId, batch, now);
    this.logger.log(`user=${requester.email} action=ingest_usage projectId=${projectId} source=${batch.telemetrySource} accepted=${result.accepted} duplicates=${result.duplicates} rejected=${result.rejected.length}`);
    return result;
  }

  /** Access already checked by the caller (a user, or later an ingest key). */
  async ingestForProject(projectId: string, batch: UsageEventBatchDto, now: Date, simulationRunId: string | null = null): Promise<IngestResult> {
    const prices = await this.pricing.rowsFor(projectId);
    const treatment = this.cfg.getTokenObservabilityCatalogue().pricing;
    const rejected: Rejection[] = [];
    const seen = new Set<string>();
    const good: NormalizedEvent[] = [];
    for (const e of batch.events) {
      if (seen.has(e.eventId)) {
        rejected.push({ eventId: e.eventId, reason: 'eventId repeated within the batch' });
        continue;
      }
      seen.add(e.eventId);
      const n = normalizeEvent(e, batch.telemetrySource, prices, projectId, treatment, now);
      if (isRejection(n)) rejected.push(n);
      else good.push({ ...n, simulationRunId });
    }
    let inserted: NormalizedEvent[] = [];
    if (good.length) {
      inserted = await this.events.manager.transaction(async (m) => {
        // Simulated rollups can be rebuilt when a run is deleted; serialise with that per project.
        if (batch.telemetrySource === 'simulated') await lockRollups(m, projectId);
        const res = await m
          .createQueryBuilder()
          .insert()
          .into(AiUsageEvent)
          .values(good.map((e) => ({ ...e, project: { id: projectId } as Project })))
          .orIgnore()
          .returning(['eventId'])
          .execute();
        const stored = new Set((res.raw as Array<{ eventId: string }>).map((r) => r.eventId));
        const fresh = good.filter((e) => stored.has(e.eventId));
        await this.addToRollups(m, projectId, fresh);
        return fresh;
      });
    }
    return {
      received: batch.events.length,
      accepted: inserted.length,
      duplicates: good.length - inserted.length,
      rejected,
      unpriced: inserted.filter((e) => e.estimatedTotalCost === null).length,
    };
  }

  /** Adds new events to their hourly buckets; concurrent batches add atomically (ON CONFLICT ... DO UPDATE). */
  private async addToRollups(m: EntityManager, projectId: string, events: NormalizedEvent[]) {
    const keyCols = ['projectId', 'bucketStart', 'telemetrySource', ...ROLLUP_DIMENSIONS];
    const cols = [...keyCols, ...ROLLUP_MEASURES];
    const q = (c: string) => `"${c}"`;
    for (const d of rollupDeltas(events)) {
      const values = [projectId, d.bucketStart, d.telemetrySource, ...ROLLUP_DIMENSIONS.map((k) => d[k]), ...ROLLUP_MEASURES.map((k) => d[k])];
      await m.query(
        `INSERT INTO "ai_usage_rollups" (${cols.map(q).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (${keyCols.map(q).join(', ')}) DO UPDATE SET ${ROLLUP_MEASURES.map((c) => `${q(c)} = "ai_usage_rollups".${q(c)} + EXCLUDED.${q(c)}`).join(', ')}`,
        values,
      );
    }
  }

  // --------------------------------------------------------------- queries
  private async scope(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto): Promise<UsageFilters> {
    await this.projectsService.findOne(projectId, requester);
    if (q.tenant && !canSeeTenants(requester.role)) throw new ForbiddenException('Filtering by tenant needs the admin or architect role.');
    const f = resolveFilters(q, new Date());
    if ('error' in f) throw new BadRequestException(f.error);
    return f;
  }

  private sql<T = Record<string, unknown>>(query: string, params: unknown[]): Promise<T[]> {
    return this.events.manager.query(query, params);
  }

  private range(f: UsageFilters) {
    return { mode: f.mode, from: f.from.toISOString(), to: f.to.toISOString(), filters: f.dims };
  }

  private async requests(projectId: string, f: UsageFilters) {
    const w = whereClause(projectId, f, 'events', 'e');
    const [r] = await this.sql(
      `SELECT COUNT(DISTINCT COALESCE(e."requestId", e."traceId", e."eventId")) AS requests,
              COALESCE(SUM(e."totalTokens") FILTER (WHERE e."requestStatus" = 'success'), 0) AS "successfulRequestTokens",
              COUNT(*) FILTER (WHERE e."requestStatus" = 'error') AS errors,
              AVG(e."latencyMs") FILTER (WHERE e."llmCallCount" > 0) AS "avgLatencyMs",
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e."latencyMs") FILTER (WHERE e."llmCallCount" > 0) AS "p95LatencyMs",
              AVG(e."ttftMs") AS "avgTtftMs",
              COUNT(*) FILTER (WHERE e."estimatedTotalCost" IS NULL AND (e."totalTokens" + e."embeddingTokens" + e."rerankingTokens") > 0) AS "unpricedEvents"
         FROM "ai_usage_events" e WHERE ${w.sql}`,
      w.params,
    );
    return {
      requests: num(r.requests),
      successfulRequestTokens: num(r.successfulRequestTokens),
      errors: num(r.errors),
      avgLatencyMs: numOrNull(r.avgLatencyMs),
      p95LatencyMs: numOrNull(r.p95LatencyMs),
      avgTtftMs: numOrNull(r.avgTtftMs),
      unpricedEvents: num(r.unpricedEvents),
    };
  }

  private async totals(projectId: string, f: UsageFilters) {
    const w = whereClause(projectId, f, 'rollups', 'r');
    const [r] = await this.sql(`SELECT ${TOKEN_SUMS}, SUM("llmCalls") AS "llmCalls", SUM("toolCalls") AS "toolCalls", SUM("costTotal") AS cost, SUM(events) AS events FROM "ai_usage_rollups" r WHERE ${w.sql}`, w.params);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])) as Record<string, number>;
  }

  private async grouped(projectId: string, f: UsageFilters, cols: string[], limit = 50) {
    const w = whereClause(projectId, f, 'rollups', 'r');
    const g = cols.map((c) => `r."${c}"`).join(', ');
    const rows = await this.sql(
      `SELECT ${g}, ${TOKEN_SUMS}, SUM("llmCalls") AS "llmCalls", SUM("toolCalls") AS "toolCalls", SUM("costTotal") AS cost, SUM(events) AS events, SUM("latencyMsSum") AS "latencyMsSum", SUM(errors) AS errors
         FROM "ai_usage_rollups" r WHERE ${w.sql} GROUP BY ${g} ORDER BY SUM("totalTokens" + "embeddingTokens" + "rerankingTokens") DESC LIMIT ${limit}`,
      w.params,
    );
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = cols.includes(k) ? (v === '' ? null : v) : num(v);
      return out as Record<string, any> & { totalTokens: number };
    });
  }

  async telemetryStatus(projectId: string): Promise<{ status: TelemetryStatus; lastLive: string | null; lastSimulated: string | null }> {
    const [r] = await this.sql<{ live: Date | null; simulated: Date | null }>(
      `SELECT MAX("timestamp") FILTER (WHERE "telemetrySource" = 'live') AS live, MAX("timestamp") FILTER (WHERE "telemetrySource" = 'simulated') AS simulated FROM "ai_usage_events" WHERE "projectId" = $1`,
      [projectId],
    );
    const staleMs = this.cfg.getTokenObservabilityCatalogue().observed.liveStaleAfterHours * 3_600_000;
    const status: TelemetryStatus = r.live ? (Date.now() - new Date(r.live).getTime() > staleMs ? 'stale' : 'receiving') : r.simulated ? 'simulated_only' : 'no_telemetry';
    return { status, lastLive: r.live ? new Date(r.live).toISOString() : null, lastSimulated: r.simulated ? new Date(r.simulated).toISOString() : null };
  }

  /** GET summary - the spec §5 executive cards, for observed usage. */
  async summary(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const [t, req, base, top, telemetry] = await Promise.all([this.totals(projectId, f), this.requests(projectId, f), this.totals(projectId, previousWindow(f)), this.grouped(projectId, f, ['applicationId', 'serviceId'], 1), this.telemetryStatus(projectId)]);
    return {
      ...this.range(f),
      telemetry,
      empty: t.events === 0,
      cards: {
        totalTokens: t.totalTokens,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        requests: req.requests,
        tokensPerRequest: req.requests ? Math.round(t.totalTokens / req.requests) : null,
        cost: t.events ? t.cost : null,
        costIncomplete: req.unpricedEvents > 0,
        topConsumer: top[0] ? { application: top[0].applicationId, service: top[0].serviceId, totalTokens: top[0].totalTokens } : null,
        growthVsBaselinePercent: growthVsBaseline(t.totalTokens, base.totalTokens).percent,
        growthNote: growthVsBaseline(t.totalTokens, base.totalTokens).note,
        baselineTotalTokens: base.totalTokens,
      },
    };
  }

  /** GET tokens - every mandatory metric of spec §6 for the range. */
  async tokens(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const [t, req] = await Promise.all([this.totals(projectId, f), this.requests(projectId, f)]);
    const per = (x: number) => (req.requests ? Math.round((x / req.requests) * 100) / 100 : null);
    return {
      ...this.range(f),
      totals: t,
      requests: req.requests,
      successfulRequestTokens: req.successfulRequestTokens,
      errors: req.errors,
      tokensPerRequest: per(t.totalTokens),
      llmCallsPerRequest: per(t.llmCalls),
      toolCallsPerRequest: per(t.toolCalls),
      latencyMs: { avg: req.avgLatencyMs, p95: req.p95LatencyMs },
      ttftMs: { avg: req.avgTtftMs },
    };
  }

  /** GET trends - tokens and cost per hour or day. */
  async trends(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const w = whereClause(projectId, f, 'rollups', 'r');
    const rows = await this.sql(
      `SELECT to_char(date_trunc('${f.bucket}', r."bucketStart" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"') AS bucket, ${TOKEN_SUMS}, SUM("costTotal") AS cost, SUM(events) AS events, SUM("llmCalls") AS "llmCalls"
         FROM "ai_usage_rollups" r WHERE ${w.sql} GROUP BY 1 ORDER BY 1`,
      w.params,
    );
    return {
      ...this.range(f),
      bucket: f.bucket,
      points: rows.map((r) => ({ bucket: r.bucket as string, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'bucket').map(([k, v]) => [k, num(v)])) })),
    };
  }

  /** GET services - consumption by application and business service. */
  async services(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    return { ...this.range(f), rows: withShare(await this.grouped(projectId, f, ['applicationId', 'serviceId', 'workflowId'])) };
  }

  /** GET models - consumption by provider and model. */
  async models(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const rows = await this.grouped(projectId, f, ['provider', 'model']);
    return { ...this.range(f), rows: withShare(rows.map((r) => ({ ...r, avgLatencyMs: r.events ? Math.round(r.latencyMsSum / r.events) : null }))) };
  }

  /** GET agents - spec §9: calls, tokens and cost per task, tokens by step, loop indicator. */
  async agents(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const w = whereClause(projectId, f, 'events', 'e');
    const threshold = await this.loopThreshold(projectId);
    const [perAgent, perStep] = await Promise.all([
      this.sql(
        `WITH t AS (
           SELECT e."agentId", COALESCE(e."traceId", e."requestId", e."eventId") AS task, SUM(e."llmCallCount") AS llm, SUM(e."toolCallCount") AS tools,
                  SUM(e."totalTokens") AS tokens, SUM(e."estimatedTotalCost") AS cost, COUNT(*) FILTER (WHERE e."estimatedTotalCost" IS NULL) AS unpriced
             FROM "ai_usage_events" e WHERE ${w.sql} AND e."agentId" IS NOT NULL GROUP BY 1, 2)
         SELECT "agentId", COUNT(*) AS tasks, SUM(llm) AS "llmCalls", SUM(tools) AS "toolCalls", SUM(tokens) AS "totalTokens", SUM(cost) AS cost,
                MAX(llm) AS "maxLlmCallsPerTask", COUNT(*) FILTER (WHERE llm > $${w.params.length + 1}) AS "tasksOverLimit", SUM(unpriced) AS unpriced
           FROM t GROUP BY 1 ORDER BY SUM(tokens) DESC LIMIT 50`,
        [...w.params, threshold],
      ),
      this.sql(
        `SELECT e."agentId", e."operationType", e."toolName", COUNT(*) AS calls, SUM(e."inputTokens") AS "inputTokens", SUM(e."outputTokens") AS "outputTokens", SUM(e."totalTokens") AS "totalTokens", AVG(e."latencyMs") AS "avgLatencyMs"
           FROM "ai_usage_events" e WHERE ${w.sql} AND e."agentId" IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, SUM(e."totalTokens") DESC`,
        w.params,
      ),
    ]);
    return {
      ...this.range(f),
      loopThreshold: threshold,
      agents: perAgent.map((a) => {
        const tasks = num(a.tasks);
        return {
          agentId: a.agentId as string,
          tasks,
          llmCallsPerTask: tasks ? num(a.llmCalls) / tasks : 0,
          toolCallsPerTask: tasks ? num(a.toolCalls) / tasks : 0,
          tokensPerTask: tasks ? Math.round(num(a.totalTokens) / tasks) : 0,
          costPerTask: tasks && a.cost !== null ? num(a.cost) / tasks : null,
          costIncomplete: num(a.unpriced) > 0,
          totalTokens: num(a.totalTokens),
          maxLlmCallsPerTask: num(a.maxLlmCallsPerTask),
          tasksOverLimit: num(a.tasksOverLimit),
          steps: perStep
            .filter((s) => s.agentId === a.agentId)
            .map((s) => ({ operationType: s.operationType as string, toolName: (s.toolName as string) ?? null, calls: num(s.calls), inputTokens: num(s.inputTokens), outputTokens: num(s.outputTokens), totalTokens: num(s.totalTokens), avgLatencyMs: numOrNull(s.avgLatencyMs) })),
        };
      }),
    };
  }

  /** GET rag - spec §8 by RAG stage, and the observed context expansion ratio. */
  async rag(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const w = whereClause(projectId, f, 'events', 'e');
    const rows = await this.sql(
      `SELECT e."ragStage", COUNT(*) AS events, COUNT(DISTINCT COALESCE(e."requestId", e."traceId", e."eventId")) AS requests, ${TOKEN_SUMS.replace(/SUM\("/g, 'SUM(e."')}, SUM(e."retrievalCount") AS "retrievalCount", SUM(e."estimatedTotalCost") AS cost
         FROM "ai_usage_events" e WHERE ${w.sql} AND e."ragStage" IS NOT NULL GROUP BY 1`,
      w.params,
    );
    const stage = (s: string) => rows.find((r) => r.ragStage === s);
    const n = (s: string, k: string) => num(stage(s)?.[k]);
    const queryTokens = n('query_embedding', 'embeddingTokens');
    const context = n('generation', 'contextTokens');
    const requests = Math.max(0, ...rows.map((r) => num(r.requests)));
    return {
      ...this.range(f),
      empty: rows.length === 0,
      requests,
      stages: rows.map((r) => ({ stage: r.ragStage as string, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'ragStage').map(([k, v]) => [k, k === 'cost' ? numOrNull(v) : num(v)])) })),
      perRequest: requests
        ? {
            queryEmbeddingTokens: queryTokens / requests,
            retrievedChunks: n('retrieval', 'retrievalCount') / requests,
            rerankingTokens: n('rerank', 'rerankingTokens') / requests,
            contextTokens: context / requests,
            finalInputTokens: n('generation', 'inputTokens') / requests,
            outputTokens: n('generation', 'outputTokens') / requests,
          }
        : null,
      // Retrieved context tokens / original query tokens; the embedded query is the measurable query size.
      contextExpansionRatio: queryTokens > 0 ? Math.round((context / queryTokens) * 10) / 10 : null,
    };
  }

  /** GET cost - observed cost against the estimate and the budget. */
  async cost(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const [byModel, req, estimate] = await Promise.all([
      this.grouped(projectId, f, ['provider', 'model']),
      this.requests(projectId, f),
      this.estimates.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } }),
    ]);
    const observed = byModel.reduce((s, r) => s + r.cost, 0);
    const days = (f.to.getTime() - f.from.getTime()) / 86_400_000;
    // A month is only projected from at least a day of usage; a short load test would scale into nonsense.
    const monthlyRunRate = byModel.length && days >= 1 ? Math.round((observed / days) * 30.4 * 100) / 100 : null;
    const estimated = estimate?.result.cost.monthlyUsd ?? null;
    return {
      ...this.range(f),
      currency: this.cfg.getTokenObservabilityCatalogue().pricing.currency,
      observedCost: byModel.length ? Math.round(observed * 100) / 100 : null,
      costIncomplete: req.unpricedEvents > 0,
      unpricedEvents: req.unpricedEvents,
      byModel: byModel.map((r) => ({ provider: r.provider, model: r.model, cost: r.cost, totalTokens: r.totalTokens, embeddingTokens: r.embeddingTokens })),
      forecast: { monthlyRunRate, basis: days >= 1 ? `observed ${days.toFixed(1)} days scaled to 30.4` : 'range shorter than a day - not projected to a month' },
      estimate: estimate ? { version: estimate.version, monthlyUsd: estimated, deltaPercent: estimated && monthlyRunRate !== null ? growth(monthlyRunRate, estimated) : null } : null,
      budget: estimate?.result.budget.monthlyBudgetUsd ? { monthlyUsd: estimate.result.budget.monthlyBudgetUsd, shareUsed: monthlyRunRate !== null ? Math.round((monthlyRunRate / estimate.result.budget.monthlyBudgetUsd) * 1000) / 10 : null, source: estimate.result.budget.source } : null,
    };
  }

  /** GET traces/:traceId - the request → agent → LLM → tool tree. */
  async trace(projectId: string, requester: AuthenticatedUser, traceId: string) {
    await this.projectsService.findOne(projectId, requester);
    const rows = await this.events.find({ where: { project: { id: projectId }, traceId }, order: { timestamp: 'ASC' }, take: 5000 });
    if (!rows.length) throw new NotFoundException(`No usage events for trace '${traceId}' in this project.`);
    const threshold = await this.loopThreshold(projectId);
    // Only what the trace view needs - no tenant, session or other identifiers leave through this endpoint.
    const spans: SpanRow[] = rows.map((r) => ({
      eventId: r.eventId, timestamp: r.timestamp, spanId: r.spanId, parentSpanId: r.parentSpanId, operationType: r.operationType, provider: r.provider, model: r.model,
      agentId: r.agentId, toolName: r.toolName, ragStage: r.ragStage, inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens: r.totalTokens,
      embeddingTokens: r.embeddingTokens, rerankingTokens: r.rerankingTokens, llmCallCount: r.llmCallCount, toolCallCount: r.toolCallCount, latencyMs: r.latencyMs,
      ttftMs: r.ttftMs, requestStatus: r.requestStatus, errorType: r.errorType, estimatedTotalCost: r.estimatedTotalCost,
    }));
    return { traceId, telemetrySource: [...new Set(rows.map((r) => r.telemetrySource))], ...buildTrace(spans, threshold) };
  }

  /** The design's agent step limit when there is one, else the configured default. */
  private async loopThreshold(projectId: string): Promise<number> {
    const e = await this.estimates.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    return e?.result.agent?.llmCallsPerTask ?? this.cfg.getTokenObservabilityCatalogue().observed.loopLlmCallsPerTrace;
  }

  /** GET requests - drill-down from any aggregate to the requests behind it (spec §19). */
  async requestList(projectId: string, requester: AuthenticatedUser, q: UsageRequestsQueryDto) {
    const f = await this.scope(projectId, requester, q);
    const w = whereClause(projectId, f, 'events', 'e');
    const params = [...w.params];
    let extra = '';
    if (q.agent) {
      params.push(q.agent);
      extra = ` AND e."agentId" = $${params.length}`;
    }
    const order = { recent: 'started DESC', tokens: '"totalTokens" DESC, started DESC', cost: 'cost DESC NULLS LAST, started DESC' }[q.sort ?? 'recent'];
    const limit = q.limit ?? 50;
    params.push(limit + 1, q.offset ?? 0);
    const rows = await this.sql(
      `SELECT COALESCE(e."requestId", e."traceId", e."eventId") AS request, MIN(e."traceId") AS "traceId", MIN(e."timestamp") AS started,
              MAX(e."applicationId") AS "applicationId", MAX(e."serviceId") AS "serviceId", MAX(e."workflowId") AS "workflowId", MAX(e."agentId") AS "agentId",
              STRING_AGG(DISTINCT e."model", ', ') AS models, COUNT(*) AS spans, SUM(e."inputTokens") AS "inputTokens", SUM(e."outputTokens") AS "outputTokens", SUM(e."totalTokens") AS "totalTokens",
              SUM(e."embeddingTokens") AS "embeddingTokens", SUM(e."llmCallCount") AS "llmCalls", SUM(e."toolCallCount") AS "toolCalls", SUM(e."estimatedTotalCost") AS cost,
              BOOL_OR(e."estimatedTotalCost" IS NULL AND (e."totalTokens" + e."embeddingTokens" + e."rerankingTokens") > 0) AS "costIncomplete", BOOL_OR(e."requestStatus" = 'error') AS failed, MAX(e."latencyMs") AS "maxLatencyMs"
         FROM "ai_usage_events" e WHERE ${w.sql}${extra} GROUP BY 1 ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const numeric = ['spans', 'inputTokens', 'outputTokens', 'totalTokens', 'embeddingTokens', 'llmCalls', 'toolCalls'];
    return {
      ...this.range(f),
      sort: q.sort ?? 'recent',
      offset: q.offset ?? 0,
      hasMore: rows.length > limit,
      rows: rows.slice(0, limit).map((r) => ({ ...r, ...Object.fromEntries(numeric.map((k) => [k, num(r[k])])), cost: numOrNull(r.cost), maxLatencyMs: numOrNull(r.maxLatencyMs), started: new Date(r.started as string).toISOString() })),
    };
  }

  /** GET dimensions - the values each filter can take in the range (for the filter bar). */
  async dimensions(projectId: string, requester: AuthenticatedUser, q: UsageQueryDto) {
    const f = await this.scope(projectId, requester, q);
    // Every filter but the dimension itself, so a chosen value never hides its alternatives.
    const cols = { environment: 'environment', application: 'applicationId', service: 'serviceId', workflow: 'workflowId', provider: 'provider', model: 'model', tenant: 'tenantId', agent: 'agentId' } as const;
    const out: Record<string, string[]> = {};
    await Promise.all(
      (Object.entries(cols) as Array<[keyof typeof cols, string]>).map(async ([name, col]) => {
        const own = { ...f, dims: Object.fromEntries(Object.entries(f.dims).filter(([k]) => k !== name)) };
        const w = whereClause(projectId, own, 'rollups', 'r');
        const rows = await this.sql<{ v: string }>(`SELECT DISTINCT r."${col}" AS v FROM "ai_usage_rollups" r WHERE ${w.sql} AND r."${col}" <> '' ORDER BY 1 LIMIT 200`, w.params);
        out[name] = rows.map((r) => r.v);
      }),
    );
    // Tenant ids identify customers: only roles that may see them get the list (spec §18).
    const tenantHidden = !canSeeTenants(requester.role);
    if (tenantHidden) out.tenant = [];
    return { ...this.range(f), values: out, tenantHidden };
  }

  /** Observed figures for the central state (spec §16): last 30 days, live if any, else simulated. */
  async observedState(projectId: string) {
    const telemetry = await this.telemetryStatus(projectId);
    if (telemetry.status === 'no_telemetry') return { telemetry, totals: null, topConsumers: [] as Array<{ dimension: string; key: string; totalTokens: number }> };
    const mode: ObservedSource = telemetry.lastLive ? 'live' : 'simulated';
    const f = resolveFilters({ mode }, new Date()) as UsageFilters;
    const [totals, top] = await Promise.all([this.totals(projectId, f), this.grouped(projectId, f, ['applicationId', 'serviceId'], 3)]);
    return {
      telemetry,
      mode,
      totals,
      topConsumers: top.map((t) => ({ dimension: 'application / service', key: `${t.applicationId ?? '(none)'} / ${t.serviceId ?? '(none)'}`, totalTokens: t.totalTokens })),
    };
  }
}

/** Per-project transaction lock shared by simulated ingest and run deletion, so a rebuild never races an insert. */
export async function lockRollups(m: EntityManager, projectId: string) {
  await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`token-rollups:${projectId}`]);
}
