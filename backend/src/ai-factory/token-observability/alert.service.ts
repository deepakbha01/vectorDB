import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiTokenAlert } from './token-alert.entity';
import { AiTokenEstimate } from './token-estimate.entity';
import { AlertSnapshot, evaluateRules, Evaluation, reconcile } from './alerts';
import { MANAGED_API_TIER } from './pricing';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export interface EvaluationResult extends Evaluation {
  projectId: string;
  evaluatedAt: string;
  opened: number;
  resolved: number;
}

/**
 * Token alerts (spec §14): gathers a project's live-usage snapshot, runs the
 * rules and keeps ai_token_alerts in step. Used by the schedule and by
 * "Evaluate now".
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  /** Last evaluation per project (this process), shown next to the alerts. */
  private readonly lastRun = new Map<string, EvaluationResult>();

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    @InjectRepository(AiTokenAlert) private readonly alerts: Repository<AiTokenAlert>,
    @InjectRepository(AiTokenEstimate) private readonly estimates: Repository<AiTokenEstimate>,
  ) {}

  private sql<T = Record<string, unknown>>(query: string, params: unknown[]): Promise<T[]> {
    return this.alerts.manager.query(query, params);
  }

  /** Everything the rules read, measured on live usage only. */
  async snapshot(projectId: string, now: Date): Promise<AlertSnapshot> {
    const r = this.cfg.getTokenObservabilityCatalogue().alerts.rules;
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const estimate = await this.estimates.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    const live = `e."projectId" = $1 AND e."telemetrySource" = 'live'`;
    // One pass for the windowed sums.
    const [w] = await this.sql(
      `SELECT
         COALESCE(SUM(e."estimatedTotalCost") FILTER (WHERE e."timestamp" >= $2), 0) AS "monthCost",
         COALESCE(SUM(e."totalTokens") FILTER (WHERE e."timestamp" >= $3), 0) AS "lastHourTokens",
         COALESCE(SUM(e."totalTokens") FILTER (WHERE e."timestamp" >= $4 AND e."timestamp" < $3), 0) AS "spikeBaselineTokens",
         MIN(e."timestamp") FILTER (WHERE e."timestamp" >= $4) AS "firstInSpikeBaseline",
         COALESCE(SUM(e."totalTokens") FILTER (WHERE e."timestamp" >= $5), 0) AS "tprTokens",
         COUNT(DISTINCT COALESCE(e."requestId", e."traceId", e."eventId")) FILTER (WHERE e."timestamp" >= $5) AS "tprRequests",
         COALESCE(SUM(e."estimatedTotalCost") FILTER (WHERE e."timestamp" >= $6), 0) AS "lastDayCost",
         COALESCE(SUM(e."estimatedTotalCost") FILTER (WHERE e."timestamp" >= $7 AND e."timestamp" < $6), 0) AS "costBaseline",
         MIN(e."timestamp") FILTER (WHERE e."timestamp" >= $7) AS "firstInCostBaseline"
       FROM "ai_usage_events" e WHERE ${live} AND e."timestamp" >= LEAST($2, $4, $7) AND e."timestamp" < $8`,
      [projectId, monthStart, at(HOUR), at(HOUR + r.spike.baselineDays * DAY), at(r.tokensPerRequest.lookbackHours * HOUR), at(DAY), at(DAY + r.costIncrease.baselineDays * DAY), now],
    );
    // Only count the part of a baseline window that has history, so a new project is not compared with empty days.
    const spikeHours = w.firstInSpikeBaseline ? Math.max(0, (at(HOUR).getTime() - new Date(w.firstInSpikeBaseline as string).getTime()) / HOUR) : 0;
    const costDays = w.firstInCostBaseline ? Math.max(0, Math.min(r.costIncrease.baselineDays, (at(DAY).getTime() - new Date(w.firstInCostBaseline as string).getTime()) / DAY)) : 0;

    const models = await this.sql<{ provider: string; model: string; tokens: string; recent: boolean; before: boolean }>(
      `SELECT e.provider, e.model, SUM(e."totalTokens" + e."embeddingTokens" + e."rerankingTokens") AS tokens, BOOL_OR(e."timestamp" >= $2) AS recent, BOOL_OR(e."timestamp" < $2) AS before
         FROM "ai_usage_events" e WHERE ${live} AND e."timestamp" >= $3 AND e."timestamp" < $4 AND e."operationType" <> 'execute_tool' AND e.provider <> 'unknown'
        GROUP BY 1, 2`,
      [projectId, at(r.unexpectedModel.lookbackHours * HOUR), at((r.unexpectedModel.lookbackHours * HOUR) + r.unexpectedModel.baselineDays * DAY), now],
    );

    const threshold = estimate?.result.agent?.llmCallsPerTask ?? this.cfg.getTokenObservabilityCatalogue().observed.loopLlmCallsPerTrace;
    const agents = await this.sql(
      `WITH t AS (SELECT e."agentId", COALESCE(e."traceId", e."requestId", e."eventId") AS task, SUM(e."llmCallCount") AS llm
                    FROM "ai_usage_events" e WHERE ${live} AND e."agentId" IS NOT NULL AND e."timestamp" >= $2 AND e."timestamp" < $3 GROUP BY 1, 2)
       SELECT "agentId", COUNT(*) FILTER (WHERE llm > $4) AS tasks, MAX(llm) AS "maxLlm" FROM t GROUP BY 1 HAVING COUNT(*) FILTER (WHERE llm > $4) > 0`,
      [projectId, at(r.agentLoops.lookbackHours * HOUR), now, threshold],
    );

    const [rag] = await this.sql(
      `SELECT COUNT(DISTINCT COALESCE(e."requestId", e."traceId", e."eventId")) FILTER (WHERE e."timestamp" >= $2) AS "recentRequests",
              COALESCE(SUM(e."contextTokens") FILTER (WHERE e."timestamp" >= $2), 0) AS "recentContext",
              COUNT(DISTINCT COALESCE(e."requestId", e."traceId", e."eventId")) FILTER (WHERE e."timestamp" < $2) AS "baselineRequests",
              COALESCE(SUM(e."contextTokens") FILTER (WHERE e."timestamp" < $2), 0) AS "baselineContext"
         FROM "ai_usage_events" e WHERE ${live} AND e."ragStage" = 'generation' AND e."timestamp" >= $3 AND e."timestamp" < $4`,
      [projectId, at(r.ragContextGrowth.lookbackHours * HOUR), at(r.ragContextGrowth.lookbackHours * HOUR + r.ragContextGrowth.baselineDays * DAY), now],
    );

    // What the design expects: the estimate's embedding model (its LLM is priced by tier, which live events do not name).
    const expected: string[] = [];
    const embedding = (estimate?.context as { embedding?: { provider: string; model: string } } | undefined)?.embedding;
    if (embedding) expected.push(`${embedding.provider}/${embedding.model}`);
    const llm = (estimate?.context as { llm?: { provider: string; model: string } } | undefined)?.llm;
    if (llm && llm.provider !== MANAGED_API_TIER) expected.push(`${llm.provider}/${llm.model}`);

    return {
      currency: this.cfg.getTokenObservabilityCatalogue().pricing.currency,
      budget: estimate?.result.budget.monthlyBudgetUsd ? { monthlyUsd: estimate.result.budget.monthlyBudgetUsd, source: estimate.result.budget.source } : null,
      month: { costToDate: num(w.monthCost), elapsedDays: (now.getTime() - monthStart.getTime()) / DAY, daysInMonth },
      spike: { lastHourTokens: num(w.lastHourTokens), baselineHourlyTokens: spikeHours >= 1 ? num(w.spikeBaselineTokens) / spikeHours : 0, baselineHours: spikeHours },
      tokensPerRequest: { requests: num(w.tprRequests), tokens: num(w.tprTokens), estimate: estimate?.result.perRequest.totalTokens || null, estimateVersion: estimate?.version ?? null },
      models: {
        recent: models.filter((m) => m.recent).map((m) => ({ provider: m.provider, model: m.model, tokens: num(m.tokens) })),
        seenBefore: models.filter((m) => m.before).map((m) => `${m.provider}/${m.model}`),
        hasHistory: models.some((m) => m.before),
        expected,
      },
      agents: { threshold, overLimit: agents.map((a) => ({ agentId: a.agentId as string, tasks: num(a.tasks), maxLlmCalls: num(a.maxLlm) })) },
      ragContext: { recent: { requests: num(rag.recentRequests), contextTokens: num(rag.recentContext) }, baseline: { requests: num(rag.baselineRequests), contextTokens: num(rag.baselineContext) } },
      cost: { lastDay: num(w.lastDayCost), baselineDailyAvg: costDays >= 1 ? num(w.costBaseline) / costDays : 0, baselineDays: Math.floor(costDays) },
    };
  }

  /** Runs the rules for one project and stores the outcome. Access is checked by the caller. */
  async evaluateProject(projectId: string, now = new Date()): Promise<EvaluationResult> {
    const evaluation = evaluateRules(await this.snapshot(projectId, now), this.cfg.getTokenObservabilityCatalogue().alerts);
    const { opened, resolved } = await this.alerts.manager.transaction(async (m) => {
      const open = await m.find(AiTokenAlert, { where: { project: { id: projectId }, status: 'open' }, select: { id: true, dedupeKey: true } });
      const plan = reconcile(open, evaluation.firing);
      for (const f of plan.create) {
        await m.save(m.create(AiTokenAlert, { project: { id: projectId } as Project, rule: f.rule, dedupeKey: f.dedupeKey, severity: f.severity, status: 'open', title: f.title, detail: f.detail, metric: f.metric, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, acknowledgedAt: null, acknowledgedBy: null }));
      }
      for (const { id, firing: f } of plan.refresh) await m.update(AiTokenAlert, { id }, { severity: f.severity, title: f.title, detail: f.detail, metric: f.metric, lastSeenAt: now });
      if (plan.resolve.length) await m.update(AiTokenAlert, { id: In(plan.resolve) }, { status: 'resolved', resolvedAt: now });
      return { opened: plan.create.length, resolved: plan.resolve.length };
    });
    const result: EvaluationResult = { ...evaluation, projectId, evaluatedAt: now.toISOString(), opened, resolved };
    this.lastRun.set(projectId, result);
    if (opened || resolved) this.logger.log(`action=evaluate_alerts projectId=${projectId} firing=${evaluation.firing.length} opened=${opened} resolved=${resolved}`);
    return result;
  }

  /** "Evaluate now" from the page. */
  async evaluate(projectId: string, requester: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, requester);
    return this.evaluateProject(projectId);
  }

  /** Projects worth evaluating: live usage in the last 35 days, or alerts still open. */
  async activeProjects(now = new Date()): Promise<string[]> {
    const rows = await this.sql<{ id: string }>(
      `SELECT DISTINCT "projectId" AS id FROM "ai_usage_events" WHERE "telemetrySource" = 'live' AND "timestamp" >= $1
       UNION SELECT DISTINCT "projectId" FROM "ai_token_alerts" WHERE status = 'open'`,
      [new Date(now.getTime() - 35 * DAY)],
    );
    return rows.map((r) => r.id).filter(Boolean);
  }

  async list(projectId: string, requester: AuthenticatedUser, status: 'open' | 'all' = 'open') {
    await this.projectsService.findOne(projectId, requester);
    const rows = await this.alerts.find({
      where: status === 'open' ? { project: { id: projectId }, status: 'open' } : { project: { id: projectId } },
      relations: { acknowledgedBy: true },
      order: { lastSeenAt: 'DESC' },
      take: 200,
    });
    const last = this.lastRun.get(projectId) ?? null;
    return {
      status,
      evaluateEveryMinutes: this.cfg.getTokenObservabilityCatalogue().alerts.evaluateEveryMinutes,
      lastEvaluation: last && { evaluatedAt: last.evaluatedAt, firing: last.firing.length, silent: last.silent },
      alerts: rows.map((a) => ({ ...a, project: undefined, acknowledgedBy: a.acknowledgedBy?.email ?? null })),
    };
  }

  async openCount(projectId: string): Promise<number> {
    return this.alerts.count({ where: { project: { id: projectId }, status: 'open' } });
  }

  async acknowledge(projectId: string, requester: AuthenticatedUser, alertId: string) {
    await this.projectsService.findOne(projectId, requester);
    const a = await this.alerts.findOne({ where: { id: alertId, project: { id: projectId } } });
    if (!a) throw new NotFoundException('No such alert in this project.');
    if (!a.acknowledgedAt) {
      a.acknowledgedAt = new Date();
      a.acknowledgedBy = { id: requester.id } as User;
      await this.alerts.save(a);
      this.logger.log(`user=${requester.email} action=acknowledge_alert projectId=${projectId} alert=${alertId} rule=${a.rule}`);
    }
    return { id: a.id, acknowledgedAt: a.acknowledgedAt };
  }
}
