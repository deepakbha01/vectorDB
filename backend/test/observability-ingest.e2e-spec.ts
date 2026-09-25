/**
 * Machine ingest over real HTTP (spec §11, §15, §18): the body-size limits,
 * the ingest-key guard, validation and the OTLP receiver, wired exactly as in
 * main.ts. Storage is replaced by a recorder, so no database is needed.
 */
import { gzipSync } from 'zlib';
import { request as httpRequest } from 'http';
import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureBodyParsers } from '../src/common/body-parsers';
import { AiFactoryConfigService } from '../src/ai-factory/ai-factory-config.service';
import { ObservabilityIngestController } from '../src/ai-factory/token-observability/observability-ingest.controller';
import { UsageService } from '../src/ai-factory/token-observability/usage.service';
import { IngestKeyService } from '../src/ai-factory/token-observability/ingest-key.service';
import { IngestKeyGuard } from '../src/ai-factory/token-observability/ingest-key.guard';
import { TokenObservabilityEnabledGuard } from '../src/ai-factory/token-observability/token-observability-enabled.guard';

const GOOD = 'aftk_0123456789ab_abcdefghijklmnopqrstuvwxyzABCDEF';
const REVOKED = 'aftk_ba9876543210_abcdefghijklmnopqrstuvwxyzABCDEF';

/** Any other JSON route - it must keep the 100 KB default. */
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { size: JSON.stringify(body).length };
  }
}

const ev = (i: number, extra: Record<string, unknown> = {}) => ({
  eventId: `http-${i}-${'x'.repeat(40)}`,
  timestamp: '2026-09-25T10:00:00Z',
  traceId: `trace-${i}`,
  applicationId: 'claims',
  serviceId: 'claims-api',
  workflowId: 'claims-flow',
  provider: 'managed_api_tier',
  model: 'mid',
  operationType: 'chat',
  inputTokens: 3000,
  outputTokens: 300,
  latencyMs: 1200,
  ...extra,
});

describe('machine ingest over HTTP', () => {
  let app: INestApplication;
  const received: Array<{ projectId: string; source: string; events: number }> = [];
  const flags: Record<string, string> = { AI_FACTORY_ENABLED: 'true', TOKEN_OBSERVABILITY_ENABLED: 'true' };

  beforeAll(async () => {
    const cfg = new AiFactoryConfigService({ get: () => undefined } as unknown as ConfigService);
    cfg.onModuleInit();
    const moduleRef = await Test.createTestingModule({
      controllers: [ObservabilityIngestController, EchoController],
      providers: [
        { provide: ConfigService, useValue: { get: (k: string) => flags[k] } },
        { provide: AiFactoryConfigService, useValue: cfg },
        {
          provide: UsageService,
          useValue: {
            ingestForProject: async (projectId: string, batch: { telemetrySource: string; events: unknown[] }) => {
              received.push({ projectId, source: batch.telemetrySource, events: batch.events.length });
              return { received: batch.events.length, accepted: batch.events.length, duplicates: 0, rejected: [], unpriced: 0 };
            },
          },
        },
        { provide: IngestKeyService, useValue: { verify: async (k: string) => (k === GOOD ? { projectId: 'project-from-key', keyId: 'k1', prefix: '0123456789ab' } : null) } },
        IngestKeyGuard,
        TokenObservabilityEnabledGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => (received.length = 0));

  const rawPost = (path: string, headers: Record<string, string>, body: Buffer) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const server = app.getHttpServer().listen(0, () => {
        const req = httpRequest({ port: server.address().port, path, method: 'POST', headers: { ...headers, 'Content-Length': String(body.length) } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => server.close(() => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} })));
        });
        req.on('error', reject);
        req.end(body);
      });
    });

  const post = (path: string, key: string | null = GOOD) => {
    const r = request(app.getHttpServer()).post(`/api${path}`);
    return key ? r.set('Authorization', `Bearer ${key}`) : r;
  };

  it('refuses requests without a valid, unrevoked key', async () => {
    await post('/observability/usage-events', null).send({ events: [ev(1)] }).expect(401);
    await post('/observability/usage-events', REVOKED).send({ events: [ev(1)] }).expect(401);
    await request(app.getHttpServer()).post('/api/observability/usage-events').set('X-Ingest-Key', GOOD).send({ events: [ev(1)] }).expect(200);
  });

  it('accepts a full 1000-event batch - well over the 100 KB default body limit', async () => {
    const body = { events: Array.from({ length: 1000 }, (_, i) => ev(i)) };
    expect(JSON.stringify(body).length).toBeGreaterThan(300_000);
    const res = await post('/observability/usage-events').send(body).expect(200);
    expect(res.body.accepted).toBe(1000);
    // The key decides the project, and key ingest is always live.
    expect(received).toEqual([{ projectId: 'project-from-key', source: 'live', events: 1000 }]);
  });

  it('keeps the 100 KB limit on every other route', async () => {
    await request(app.getHttpServer()).post('/api/echo').send({ pad: 'x'.repeat(50_000) }).expect(201);
    await request(app.getHttpServer()).post('/api/echo').send({ pad: 'x'.repeat(150_000) }).expect(413);
  });

  it('validates events like every other ingest path (spec §18)', async () => {
    await post('/observability/usage-events').send({ events: [ev(1, { prompt: 'What is my diagnosis?' })] }).expect(400);
    await post('/observability/usage-events').send({ events: [ev(1, { serviceId: 'patient John Smith' })] }).expect(400);
    await post('/observability/usage-events').send({ events: Array.from({ length: 1001 }, (_, i) => ev(i)) }).expect(400);
    await post('/observability/usage-events').send({ events: [ev(1)], telemetrySource: 'simulated' }).expect(400);
    expect(received).toEqual([]);
  });

  it('receives OTLP/HTTP JSON (gzip, as the collector sends it) and answers in the partial-success shape', async () => {
    const span = (spanId: string, attrs: Array<[string, unknown]>) => ({
      traceId: '5b8efff798038103d269b633813fc60c',
      spanId,
      startTimeUnixNano: '1790359832000000000',
      endTimeUnixNano: '1790359833000000000',
      attributes: attrs.map(([key, value]) => ({ key, value })),
    });
    const otlp = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claims-api' } }] },
          scopeSpans: [
            {
              spans: [
                span('a1', [['gen_ai.operation.name', { stringValue: 'chat' }], ['gen_ai.provider.name', { stringValue: 'openai' }], ['gen_ai.request.model', { stringValue: 'gpt-4o' }], ['gen_ai.usage.input_tokens', { intValue: '1200' }], ['gen_ai.usage.output_tokens', { intValue: '80' }]]),
                span('a2', [['http.request.method', { stringValue: 'POST' }]]),
                span('a3', [['gen_ai.operation.name', { stringValue: 'chat' }], ['gen_ai.agent.name', { stringValue: 'not an identifier' }]]),
              ],
            },
          ],
        },
      ],
    };
    // Sent with node:http - supertest re-encodes Buffer bodies, which would corrupt the gzip stream.
    const res = await rawPost('/api/observability/v1/traces', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${GOOD}` }, gzipSync(JSON.stringify(otlp)));
    expect(res.status).toBe(200);
    expect(received).toEqual([{ projectId: 'project-from-key', source: 'live', events: 1 }]);
    expect(res.body.partialSuccess.rejectedSpans).toBe(1);
    expect(res.body.partialSuccess.errorMessage).toMatch(/a3: agentId must be an identifier/);
  });

  it('refuses OTLP protobuf with a pointer to JSON encoding', async () => {
    const res = await post('/observability/v1/traces').set('Content-Type', 'application/x-protobuf').send(Buffer.from([1, 2, 3])).expect(415);
    expect(res.body.message).toMatch(/encoding: json/);
  });

  it('reveals nothing when Token Observability is switched off', async () => {
    flags.TOKEN_OBSERVABILITY_ENABLED = 'false';
    try {
      await post('/observability/usage-events').send({ events: [ev(1)] }).expect(404);
    } finally {
      flags.TOKEN_OBSERVABILITY_ENABLED = 'true';
    }
  });
});
