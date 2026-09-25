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

  const platformConfig = new PlatformConfigService(configService);
  platformConfig.onModuleInit();
  const inferenceConfig = new InferenceConfigService(configService);
  inferenceConfig.onModuleInit();
  const cfg = new AiFactoryConfigService({ get: () => undefined } as unknown as ConfigService);
  cfg.onModuleInit();
  pricing = new PricingService(cfg, platformConfig, inferenceConfig, projectsStub, ds.getRepository(AiModelPrice));
  usage = new UsageService(projectsStub, cfg, pricing, ds.getRepository(AiUsageEvent), ds.getRepository(AiTokenEstimate));
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
