/**
 * Token Observability - usage ingestion and queries against a real Postgres
 * (spec §10, §13, §15). Runs in a throwaway schema built from the migrations,
 * so it also proves the migrations match the entities. Needs APP_DB_* (see
 * .env); run with `npm run test:e2e -- token-usage`.
 */
import * as path from 'path';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../src/data-source';
import { PlatformConfigService } from '../src/common/config/platform-config.service';
import { InferenceConfigService } from '../src/inference/inference-config.service';
import { AiFactoryConfigService } from '../src/ai-factory/ai-factory-config.service';
import { PricingService } from '../src/ai-factory/token-observability/pricing.service';
import { UsageService } from '../src/ai-factory/token-observability/usage.service';
import { SimulationService } from '../src/ai-factory/token-observability/simulation.service';
import { AiSimulationRun } from '../src/ai-factory/token-observability/simulation-run.entity';
import { IngestKeyService } from '../src/ai-factory/token-observability/ingest-key.service';
import { AiIngestKey } from '../src/ai-factory/token-observability/ingest-key.entity';
import { AlertService } from '../src/ai-factory/token-observability/alert.service';
import { AiTokenAlert } from '../src/ai-factory/token-observability/token-alert.entity';
import { AiModelPrice } from '../src/ai-factory/token-observability/model-price.entity';
import { AiUsageEvent } from '../src/ai-factory/token-observability/usage-event.entity';
import { AiTokenEstimate } from '../src/ai-factory/token-observability/token-estimate.entity';
import { MANAGED_API_TIER } from '../src/ai-factory/token-observability/pricing';
import { UsageEventBatchDto, UsageEventDto } from '../src/ai-factory/token-observability/dto/usage-events.dto';
import { UserRole } from '../src/users/user.entity';

config({ path: path.join(__dirname, '../.env') });
const SCHEMA = `it_token_${process.pid}`;
const CONFIG_DIR = path.join(__dirname, '../config');
const PATHS: Record<string, string> = { EMBEDDINGS_CONFIG_PATH: 'embeddings.yaml', INFERENCE_CONFIG_PATH: 'inference.yaml', THRESHOLDS_CONFIG_PATH: 'thresholds.yaml', DATABASES_CONFIG_PATH: 'databases.yaml', INDEXES_CONFIG_PATH: 'indexes.yaml', INFRASTRUCTURE_CONFIG_PATH: 'infrastructure.yaml', PATTERNS_CONFIG_PATH: 'patterns.yaml' };
const configService = { get: (k: string) => (PATHS[k] ? path.join(CONFIG_DIR, PATHS[k]) : undefined) } as unknown as ConfigService;

const admin = { id: 'x', email: 'it@local', role: UserRole.ADMIN } as any;
const projectsStub = { findOne: async () => ({}) } as any;

let ds: DataSource;
let usage: UsageService;
let simulations: SimulationService;
let pricing: PricingService;
let projectId: string;

beforeAll(async () => {
  const opts = { ...(AppDataSource.options as any) };
  const bootstrap = new DataSource({ ...opts, entities: [], migrations: [] });
  await bootstrap.initialize();
  await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
  await bootstrap.destroy();
  ds = new DataSource({ ...opts, schema: SCHEMA, extra: { options: `-c search_path=${SCHEMA},public` } });
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });
  const [u] = await ds.query(`INSERT INTO users (email, "passwordHash", role) VALUES ('it@local', 'x', 'admin') RETURNING id`);
  const [p] = await ds.query(`INSERT INTO projects (name, "ownerId") VALUES ('IT project', $1) RETURNING id`, [u.id]);
  projectId = p.id;
  admin.id = u.id; // uploads record who made them

  const platformConfig = new PlatformConfigService(configService);
  platformConfig.onModuleInit();
  const inferenceConfig = new InferenceConfigService(configService);
  inferenceConfig.onModuleInit();
  const cfg = new AiFactoryConfigService({ get: () => undefined } as unknown as ConfigService);
  cfg.onModuleInit();
  pricing = new PricingService(cfg, platformConfig, inferenceConfig, projectsStub, ds.getRepository(AiModelPrice));
  usage = new UsageService(projectsStub, cfg, pricing, ds.getRepository(AiUsageEvent), ds.getRepository(AiTokenEstimate));
  simulations = new SimulationService(projectsStub, usage, ds.getRepository(AiSimulationRun), ds.getRepository(AiUsageEvent));
  await pricing.syncCatalogue(new Date('2026-09-01T00:00:00Z'));
}, 120_000);

afterAll(async () => {
  if (ds?.isInitialized) {
    await ds.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await ds.destroy();
  }
});

let n = 0;
const ev = (o: Partial<UsageEventDto>): UsageEventDto => ({ eventId: `e${++n}`, timestamp: '2026-09-25T10:15:00Z', provider: MANAGED_API_TIER, model: 'mid', operationType: 'chat', inputTokens: 1000, outputTokens: 100, environment: 'prod', applicationId: 'claims', serviceId: 'claims-api', ...o }) as UsageEventDto;
const batch = (events: UsageEventDto[], telemetrySource: 'live' | 'simulated' = 'live'): UsageEventBatchDto => ({ telemetrySource, events });
const now = new Date('2026-09-25T12:00:00Z');
const range = { from: '2026-09-25T00:00:00Z', to: '2026-09-25T12:00:00Z' };

/** One RAG + agent request: embed the query, retrieve, rerank, then an agent calling the LLM, a tool and the LLM again. */
const ragAgentTrace = (trace: string, service = 'claims-api') => [
  ev({ traceId: trace, requestId: trace, spanId: `${trace}-emb`, provider: 'openai', model: 'text-embedding-3-small', operationType: 'embeddings', inputTokens: 30, outputTokens: 0, ragStage: 'query_embedding', serviceId: service }),
  ev({ traceId: trace, requestId: trace, spanId: `${trace}-ret`, provider: 'pgvector', model: 'hnsw', operationType: 'retrieval', inputTokens: 0, outputTokens: 0, retrievalCount: 20, ragStage: 'retrieval', serviceId: service }),
  ev({ traceId: trace, requestId: trace, spanId: `${trace}-agent`, operationType: 'invoke_agent', agentId: 'claims-agent', inputTokens: 0, outputTokens: 0, serviceId: service }),
  ev({ traceId: trace, requestId: trace, spanId: `${trace}-llm1`, parentSpanId: `${trace}-agent`, agentId: 'claims-agent', inputTokens: 3000, outputTokens: 150, serviceId: service }),
  ev({ traceId: trace, requestId: trace, spanId: `${trace}-tool`, parentSpanId: `${trace}-agent`, agentId: 'claims-agent', operationType: 'execute_tool', toolName: 'policy-lookup', inputTokens: 0, outputTokens: 0, serviceId: service }),
  ev({ traceId: trace, requestId: trace, spanId: `${trace}-llm2`, parentSpanId: `${trace}-agent`, agentId: 'claims-agent', inputTokens: 3500, outputTokens: 400, contextTokens: 2560, ragStage: 'generation', latencyMs: 1200, ttftMs: 300, serviceId: service }),
];

describe('usage ingestion and queries (Postgres)', () => {
  it('seeds the catalogue prices and syncs idempotently', async () => {
    expect(await ds.getRepository(AiModelPrice).count()).toBeGreaterThan(0);
    expect(await pricing.syncCatalogue(new Date())).toEqual({ closed: 0, inserted: 0 });
  });

  it('ingests a batch, prices it and ignores the same events when re-sent', async () => {
    const events = [...ragAgentTrace('t1'), ...ragAgentTrace('t2', 'billing-api')];
    const first = await usage.ingestForProject(projectId, batch(events), now);
    expect(first).toEqual(expect.objectContaining({ received: 12, accepted: 12, duplicates: 0, rejected: [] }));
    // Retrieval spans carry no tokens; pgvector / hnsw has no price and none is needed.
    expect(first.unpriced).toBe(0);
    const again = await usage.ingestForProject(projectId, batch(events), now);
    expect(again).toEqual(expect.objectContaining({ accepted: 0, duplicates: 12 }));
  });

  it('keeps totals exact under concurrent batches into the same hourly bucket', async () => {
    await Promise.all([usage.ingestForProject(projectId, batch(ragAgentTrace('c1')), now), usage.ingestForProject(projectId, batch(ragAgentTrace('c2')), now)]);
    const [r] = await ds.query(`SELECT SUM("totalTokens") AS rollup FROM ai_usage_rollups WHERE "projectId" = $1 AND "telemetrySource" = 'live'`, [projectId]);
    const [e] = await ds.query(`SELECT SUM("totalTokens") AS events FROM ai_usage_events WHERE "projectId" = $1 AND "telemetrySource" = 'live'`, [projectId]);
    expect(Number(r.rollup)).toBe(Number(e.events));
    expect(Number(e.events)).toBe(4 * (3150 + 3900));
  });

  it('summarises the executive cards for live usage', async () => {
    const s = await usage.summary(projectId, admin, range);
    expect(s.cards).toEqual(
      expect.objectContaining({ totalTokens: 4 * 7050, inputTokens: 4 * 6500, outputTokens: 4 * 550, requests: 4, tokensPerRequest: 7050, costIncomplete: false, growthVsBaselinePercent: null }),
    );
    // Mid tier: 6,500 × $3 + 550 × $15 per 1M, plus 30 embedding tokens × $0.02 per 1M - per request.
    expect(s.cards.cost).toBeCloseTo(4 * ((6500 * 3 + 550 * 15 + 30 * 0.02) / 1e6), 8);
    expect(s.cards.topConsumer).toEqual({ application: 'claims', service: 'claims-api', totalTokens: 3 * 7050 });
  });

  it('breaks usage down by service, model, RAG stage and agent, and filters consistently', async () => {
    const services = await usage.services(projectId, admin, range);
    expect(services.rows.map((r: any) => [r.serviceId, r.totalTokens, r.share])).toEqual([
      ['claims-api', 3 * 7050, 75],
      ['billing-api', 7050, 25],
    ]);
    const filtered = await usage.summary(projectId, admin, { ...range, service: 'billing-api' });
    expect(filtered.cards.totalTokens).toBe(7050);

    const models = await usage.models(projectId, admin, range);
    expect(models.rows.find((r: any) => r.model === 'text-embedding-3-small')).toEqual(expect.objectContaining({ totalTokens: 0, embeddingTokens: 120 }));

    const rag = await usage.rag(projectId, admin, range);
    expect(rag.requests).toBe(4);
    expect(rag.contextExpansionRatio).toBe(85.3); // 2,560 context tokens / 30 query tokens
    expect(rag.perRequest).toEqual(expect.objectContaining({ retrievedChunks: 20, contextTokens: 2560, finalInputTokens: 3500 }));

    const agents = await usage.agents(projectId, admin, range);
    expect(agents.agents).toEqual([expect.objectContaining({ agentId: 'claims-agent', tasks: 4, llmCallsPerTask: 2, toolCallsPerTask: 1, tokensPerTask: 7050, maxLlmCallsPerTask: 2, tasksOverLimit: 0 })]);
    expect(agents.agents[0].steps.find((s: any) => s.toolName === 'policy-lookup')).toEqual(expect.objectContaining({ operationType: 'execute_tool', calls: 4 }));

    const trends = await usage.trends(projectId, admin, range);
    expect(trends.points).toEqual([expect.objectContaining({ bucket: '2026-09-25T10:00:00Z', totalTokens: 4 * 7050 })]);

    const tokens = await usage.tokens(projectId, admin, range);
    expect(tokens).toEqual(expect.objectContaining({ requests: 4, llmCallsPerRequest: 2, toolCallsPerRequest: 1, successfulRequestTokens: 4 * 7050 }));
    expect(tokens.latencyMs.avg).toBe(1200); // only spans that report latency are averaged
  });

  it('returns the trace tree for one request', async () => {
    const t = await usage.trace(projectId, admin, 't1');
    expect(t.telemetrySource).toEqual(['live']);
    const agent = t.roots.find((r) => r.spanId === 't1-agent')!;
    expect(agent.children.map((c) => c.spanId)).toEqual(['t1-llm1', 't1-tool', 't1-llm2']);
    expect(t.totals).toEqual(expect.objectContaining({ llmCalls: 2, toolCalls: 1, totalTokens: 7050 }));
  });

  it('drills down to the requests behind an aggregate, newest first or heaviest first', async () => {
    const list = await usage.requestList(projectId, admin, { ...range, service: 'claims-api', sort: 'tokens', limit: 2 });
    expect(list.rows).toHaveLength(2);
    expect(list.hasMore).toBe(true);
    expect(list.rows[0]).toEqual(expect.objectContaining({ serviceId: 'claims-api', agentId: 'claims-agent', totalTokens: 7050, llmCalls: 2, toolCalls: 1, embeddingTokens: 30, failed: false, costIncomplete: false }));
    const page2 = await usage.requestList(projectId, admin, { ...range, service: 'claims-api', limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it('lists the values each filter can take, ignoring the selection made in that same filter', async () => {
    const d = await usage.dimensions(projectId, admin, { ...range, service: 'billing-api' });
    expect(d.values.service).toEqual(['billing-api', 'claims-api']);
    expect(d.values.agent).toEqual(['claims-agent']);
    expect(d.values.model).toEqual(expect.arrayContaining(['mid', 'text-embedding-3-small']));
    expect(d.values.tenant).toEqual([]);
  });

  it('keeps simulated usage separate from live', async () => {
    await usage.ingestForProject(projectId, batch([ev({ eventId: 'sim-1', inputTokens: 99_000, outputTokens: 1000 })], 'simulated'), now);
    expect((await usage.summary(projectId, admin, range)).cards.totalTokens).toBe(4 * 7050);
    expect((await usage.summary(projectId, admin, { ...range, mode: 'simulated' })).cards.totalTokens).toBe(100_000);
  });

  it('prices each event at the price in force when it happened - a later price change never rewrites history', async () => {
    const before = await ds.getRepository(AiUsageEvent).findOneByOrFail({ eventId: 'e4' } as any);
    await pricing.addProjectPrice(projectId, admin, { provider: MANAGED_API_TIER, model: 'mid', tokenType: 'input', pricePer1M: 1, effectiveFrom: '2026-09-25T11:00:00Z', source: 'contract' });
    await usage.ingestForProject(projectId, batch([ev({ eventId: 'late', timestamp: '2026-09-25T11:30:00Z', inputTokens: 1_000_000, outputTokens: 0 })]), now);
    const after = await ds.getRepository(AiUsageEvent).findOneByOrFail({ eventId: 'e4' } as any);
    expect(after.estimatedTotalCost).toBe(before.estimatedTotalCost);
    const late = await ds.getRepository(AiUsageEvent).findOneByOrFail({ eventId: 'late' } as any);
    expect(late.estimatedInputCost).toBeCloseTo(1); // 1M tokens at the contracted $1
    expect(late.priceRefs[0]).toEqual(expect.objectContaining({ pricePer1M: 1 }));
  });

  it('rejects events it cannot trust and reports each one', async () => {
    const r = await usage.ingestForProject(projectId, batch([ev({ eventId: 'dup' }), ev({ eventId: 'dup' }), ev({ eventId: 'future', timestamp: '2026-09-26T00:00:00Z' })]), now);
    expect(r.accepted).toBe(1);
    expect(r.rejected.map((x) => x.eventId)).toEqual(['dup', 'future']);
  });
});

describe('simulated runs (spec §12) - upload, list, delete', () => {
  const csv = (prefix: string) =>
    [
      'event_id,timestamp,provider,model,operation_type,input_tokens,output_tokens,service_id,trace_id',
      `${prefix}-1,2026-09-24T08:10:00Z,managed_api_tier,mid,chat,2000,200,loadtest-api,${prefix}-t1`,
      `${prefix}-2,2026-09-24T08:20:00Z,managed_api_tier,mid,chat,3000,300,loadtest-api,${prefix}-t2`,
      `${prefix}-3,2026-09-24T09:05:00Z,managed_api_tier,mid,chat,4000,400,loadtest-api,${prefix}-t3`,
      `${prefix}-4,not-a-date,managed_api_tier,mid,chat,1,1,loadtest-api,${prefix}-t4`,
    ].join('\n');
  const file = (content: string, name = 'loadtest.csv') => ({ originalname: name, size: Buffer.byteLength(content), buffer: Buffer.from(content) });
  const sums = async (source: string) => {
    const [r] = await ds.query(`SELECT COALESCE(SUM("totalTokens"), 0) AS t, COALESCE(SUM(events), 0) AS n FROM ai_usage_rollups WHERE "projectId" = $1 AND "telemetrySource" = $2`, [projectId, source]);
    const [e] = await ds.query(`SELECT COALESCE(SUM("totalTokens"), 0) AS t, COUNT(*) AS n FROM ai_usage_events WHERE "projectId" = $1 AND "telemetrySource" = $2`, [projectId, source]);
    return { rollupTokens: Number(r.t), rollupEvents: Number(r.n), eventTokens: Number(e.t), events: Number(e.n) };
  };
  let runA: string;
  let runB: string;

  it('stores an upload as simulated usage and reports rejected rows with their row numbers', async () => {
    const liveBefore = await sums('live');
    const a = await simulations.upload(projectId, admin, file(csv('ra'), 'run-a.csv'), 'Load test A', now);
    runA = a.id;
    expect(a).toEqual(expect.objectContaining({ label: 'Load test A', format: 'csv', received: 4, accepted: 3, duplicates: 0, rejected: 1, unpriced: 0 }));
    expect(a.rejections).toEqual([expect.objectContaining({ row: 4, eventId: 'ra-4' })]);
    expect(a.firstEventAt?.toISOString()).toBe('2026-09-24T08:10:00.000Z');
    expect(a.lastEventAt?.toISOString()).toBe('2026-09-24T09:05:00.000Z');
    expect(await sums('live')).toEqual(liveBefore);
    const s = await sums('simulated');
    expect(s.rollupTokens).toBe(s.eventTokens);
  });

  it('counts the same file uploaded again as duplicates, not as new usage', async () => {
    const again = await simulations.upload(projectId, admin, file(csv('ra')), undefined, now);
    expect(again).toEqual(expect.objectContaining({ label: 'loadtest.csv', accepted: 0, duplicates: 3 }));
    await simulations.remove(projectId, admin, again.id);
  });

  it('lists runs newest first', async () => {
    runB = (await simulations.upload(projectId, admin, file(csv('rb'), 'run-b.csv'), 'Load test B', now)).id;
    const list = await simulations.list(projectId, admin);
    expect(list.slice(0, 2).map((r) => r.label)).toEqual(['Load test B', 'Load test A']);
  });

  it('deletes a run and rebuilds the hourly totals it touched from what remains', async () => {
    const before = await sums('simulated');
    const res = await simulations.remove(projectId, admin, runA);
    expect(res.eventsRemoved).toBe(3);
    const after = await sums('simulated');
    // Run B shares the same hours and must survive intact.
    expect(after.eventTokens).toBe(before.eventTokens - (2200 + 3300 + 4400));
    expect(after.rollupTokens).toBe(after.eventTokens);
    expect(after.rollupEvents).toBe(after.events);
    const b = await simulations.get(projectId, admin, runB);
    expect(b.accepted).toBe(3);
    await expect(simulations.get(projectId, admin, runA)).rejects.toThrow(/No such simulation run/);
  });
});

describe('ingest keys (spec §11, §18)', () => {
  let keys: IngestKeyService;
  beforeAll(() => {
    keys = new IngestKeyService(projectsStub, ds.getRepository(AiIngestKey));
  });

  it('creates a key shown once, stores only its hash, and resolves it to the project', async () => {
    const created = await keys.create(projectId, admin, 'prod collector');
    expect(created.key).toMatch(/^aftk_/);
    const [row] = await ds.query(`SELECT * FROM ai_ingest_keys WHERE id = $1`, [created.id]);
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row.keyHash).toHaveLength(64);
    expect(await keys.verify(created.key)).toEqual({ projectId, keyId: created.id, prefix: created.prefix });
    const listed = await keys.list(projectId, admin);
    expect(listed[0]).toEqual(expect.objectContaining({ name: 'prod collector', prefix: created.prefix, revokedAt: null }));
    expect(JSON.stringify(listed)).not.toContain(created.key);
  });

  it('refuses a tampered key and, once revoked, the key itself', async () => {
    const created = await keys.create(projectId, admin, 'temporary');
    const tampered = created.key.slice(0, -1) + (created.key.endsWith('A') ? 'B' : 'A');
    expect(await keys.verify(tampered)).toBeNull();
    await keys.revoke(projectId, admin, created.id);
    expect(await keys.verify(created.key)).toBeNull();
    expect((await keys.list(projectId, admin)).find((k) => k.id === created.id)?.revokedAt).not.toBeNull();
  });
});

describe('token alerts (spec §14) - evaluate, deduplicate, acknowledge, resolve', () => {
  const NOW = new Date('2026-09-25T12:00:00Z');
  let alerts: AlertService;
  let alertProject: string;

  beforeAll(async () => {
    const [u] = await ds.query(`SELECT id FROM users LIMIT 1`);
    const [p] = await ds.query(`INSERT INTO projects (name, "ownerId") VALUES ('IT alerts', $1) RETURNING id`, [u.id]);
    alertProject = p.id;
    const cfg = new AiFactoryConfigService({ get: () => undefined } as unknown as ConfigService);
    cfg.onModuleInit();
    alerts = new AlertService(projectsStub, cfg, ds.getRepository(AiTokenAlert), ds.getRepository(AiTokenEstimate));
    // A saved estimate: 7,050 tokens per request, agents limited to 3 LLM calls, a $1 monthly budget.
    await ds.getRepository(AiTokenEstimate).save({
      project: { id: alertProject },
      createdBy: { id: u.id },
      version: 1,
      submitted: {},
      context: { embedding: { provider: 'openai', model: 'text-embedding-3-small' } },
      sources: {},
      rulesVersion: 'test',
      result: { perRequest: { totalTokens: 7050 }, agent: { llmCallsPerTask: 3 }, budget: { monthlyBudgetUsd: 1, source: 'Discovery v1' } },
    } as never);
    const ev = (id: string, at: Date, o: Record<string, unknown> = {}) => ({ eventId: id, timestamp: at.toISOString(), traceId: id, provider: MANAGED_API_TIER, model: 'mid', operationType: 'chat', inputTokens: 2000, outputTokens: 0, ...o }) as UsageEventDto;
    // A normal week: one 2,000-token request every hour.
    const week = Array.from({ length: 7 * 24 }, (_, i) => ev(`base-${i}`, new Date(NOW.getTime() - (i + 2) * 3_600_000)));
    // The last hour: a burst, a model never used before and an agent task with 5 LLM calls.
    const burst = Array.from({ length: 50 }, (_, i) => ev(`burst-${i}`, new Date(NOW.getTime() - 30 * 60_000), { inputTokens: 4000 }));
    const oddModel = [ev('odd-1', new Date(NOW.getTime() - 20 * 60_000), { provider: 'acme', model: 'x-large', inputTokens: 900 })];
    const loop = Array.from({ length: 5 }, (_, i) => ev(`loop-${i}`, new Date(NOW.getTime() - 10 * 60_000), { traceId: 'loop-trace', agentId: 'agent-a', inputTokens: 500 }));
    for (const events of [week, [...burst, ...oddModel, ...loop]]) await usage.ingestForProject(alertProject, batch(events), NOW);
  });

  it('opens one alert per problem, with the reasons it could not check others', async () => {
    const r = await alerts.evaluateProject(alertProject, NOW);
    const keys = r.firing.map((f) => `${f.dedupeKey}:${f.severity}`).sort();
    expect(keys).toEqual(expect.arrayContaining(['agentLoops:agent-a:warning', 'budget:critical', 'spike:critical', 'unexpectedModel:acme/x-large:warning']));
    // Without RAG traffic that rule says why it could not run.
    expect(r.silent.map((s) => s.rule)).toContain('ragContextGrowth');
    expect(r.opened).toBe(r.firing.length);
    const list = await alerts.list(alertProject, admin, 'open');
    expect(list.alerts).toHaveLength(r.firing.length);
    expect((await alerts.openCounts(alertProject)).open).toBe(r.firing.length);
  });

  it('refreshes rather than duplicates on the next evaluation, and records who acknowledged', async () => {
    const before = await alerts.list(alertProject, admin, 'open');
    const again = await alerts.evaluateProject(alertProject, new Date(NOW.getTime() + 60_000));
    expect(again.opened).toBe(0);
    expect((await alerts.list(alertProject, admin, 'open')).alerts).toHaveLength(before.alerts.length);
    const spike = before.alerts.find((a) => a.rule === 'spike')!;
    await alerts.acknowledge(alertProject, admin, spike.id);
    const after = (await alerts.list(alertProject, admin, 'open')).alerts.find((a) => a.id === spike.id)!;
    expect(after.acknowledgedAt).not.toBeNull();
    expect(after.acknowledgedBy).toBe('it@local');
  });

  it('resolves alerts by itself once the rule stops firing', async () => {
    // A day later the burst, the new model and the loop are out of their windows.
    const later = new Date(NOW.getTime() + 26 * 3_600_000);
    const r = await alerts.evaluateProject(alertProject, later);
    expect(r.firing.map((f) => f.rule)).not.toEqual(expect.arrayContaining(['spike']));
    expect(r.resolved).toBeGreaterThan(0);
    const all = await alerts.list(alertProject, admin, 'all');
    expect(all.alerts.find((a) => a.rule === 'spike')).toEqual(expect.objectContaining({ status: 'resolved' }));
    expect(all.alerts.find((a) => a.rule === 'agentLoops')).toEqual(expect.objectContaining({ status: 'resolved' }));
  });

  it('lists projects to evaluate on the schedule', async () => {
    expect(await alerts.activeProjects(NOW)).toEqual(expect.arrayContaining([alertProject]));
  });
});
