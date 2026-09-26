import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { mapOtlpTraces, OtelMapping, OtlpTracesRequest } from './otlp';
import { generateIngestKey, hashIngestKey, keyFromHeaders, matchesHash, prefixOf } from './ingest-keys';
import { toEventDto } from './usage-upload';
import { INGEST_PATH } from '../../common/body-parsers';

// The real mapping from config/token-observability.yaml, so the tests describe actual behaviour.
const MAPPING = (yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/token-observability.yaml'), 'utf8')) as { otel: OtelMapping }).otel;

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });
const kv = (o: Record<string, unknown>) => Object.entries(o).map(([key, value]) => ({ key, value: value as never }));
const T0 = BigInt(Date.UTC(2026, 8, 25, 10, 0, 0)) * 1_000_000n;
const ns = (ms: number) => String(T0 + BigInt(ms) * 1_000_000n);

const request = (spans: unknown[], resource: Record<string, unknown> = { 'service.name': s('claims-api'), 'deployment.environment.name': s('prod'), 'cloud.region': s('eu-west-1') }): OtlpTracesRequest =>
  ({ resourceSpans: [{ resource: { attributes: kv(resource) }, scopeSpans: [{ spans }] }] }) as OtlpTracesRequest;

const chat = {
  traceId: '5b8efff798038103d269b633813fc60c',
  spanId: 'eee19b7ec3c1b174',
  parentSpanId: 'eee19b7ec3c1b173',
  name: 'chat gpt-4o',
  startTimeUnixNano: ns(0),
  endTimeUnixNano: ns(1450),
  attributes: kv({
    'gen_ai.operation.name': s('chat'),
    'gen_ai.provider.name': s('openai'),
    'gen_ai.request.model': s('gpt-4o'),
    'gen_ai.response.model': s('gpt-4o-2024-08-06'),
    'gen_ai.usage.input_tokens': i(3200),
    'gen_ai.usage.output_tokens': i(350),
    'gen_ai.usage.cache_read.input_tokens': i(1000),
    'gen_ai.agent.name': s('claims-agent'),
    'gen_ai.conversation.id': s('conv-42'),
    'ai_factory.rag_stage': s('generation'),
    // Content is never read, even when an SDK records it.
    'gen_ai.input.messages': s('[{"role":"user","content":"What is my diagnosis?"}]'),
  }),
  status: { code: 1 },
};

describe('mapOtlpTraces (spec §11)', () => {
  it('maps a GenAI chat span onto a usage event, resource attributes included', () => {
    const r = mapOtlpTraces(request([chat]), MAPPING);
    expect(r.skipped).toBe(0);
    expect(r.rejected).toEqual([]);
    expect(r.events[0].event).toEqual({
      eventId: '5b8efff798038103d269b633813fc60c-eee19b7ec3c1b174',
      timestamp: '2026-09-25T10:00:00.000Z',
      traceId: '5b8efff798038103d269b633813fc60c',
      spanId: 'eee19b7ec3c1b174',
      parentSpanId: 'eee19b7ec3c1b173',
      requestId: '5b8efff798038103d269b633813fc60c',
      operationType: 'chat',
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
      inputTokens: 3200,
      outputTokens: 350,
      cachedInputTokens: 1000,
      agentId: 'claims-agent',
      sessionId: 'conv-42',
      ragStage: 'generation',
      latencyMs: 1450,
      serviceId: 'claims-api',
      environment: 'prod',
      region: 'eu-west-1',
    });
    // Message content never reaches the event.
    expect(JSON.stringify(r.events)).not.toMatch(/diagnosis/);
    // And the result passes the same validation as every other ingest path.
    expect('dto' in toEventDto(r.events[0].event)).toBe(true);
  });

  it('understands the older GenAI attribute names', () => {
    const old = { ...chat, attributes: kv({ 'gen_ai.operation.name': s('chat'), 'gen_ai.system': s('openai'), 'gen_ai.request.model': s('gpt-4'), 'gen_ai.usage.prompt_tokens': i(100), 'gen_ai.usage.completion_tokens': i(20) }) };
    expect(mapOtlpTraces(request([old]), MAPPING).events[0].event).toEqual(expect.objectContaining({ provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 20 }));
  });

  it('skips spans that are not GenAI calls', () => {
    const http = { traceId: 'a1', spanId: 'b1', startTimeUnixNano: ns(0), attributes: kv({ 'http.request.method': s('GET') }) };
    const r = mapOtlpTraces(request([http, chat]), MAPPING);
    expect(r.skipped).toBe(1);
    expect(r.events).toHaveLength(1);
  });

  it('lets a span attribute win over the resource, and fills provider / model for tool spans', () => {
    const tool = { traceId: 'a1', spanId: 'b2', startTimeUnixNano: ns(0), attributes: kv({ 'gen_ai.operation.name': s('execute_tool'), 'gen_ai.tool.name': s('policy-lookup'), 'ai_factory.service_id': s('claims-tools') }) };
    expect(mapOtlpTraces(request([tool]), MAPPING).events[0].event).toEqual(expect.objectContaining({ serviceId: 'claims-tools', provider: 'unknown', model: 'policy-lookup', toolName: 'policy-lookup' }));
  });

  it('marks error spans, and rejects GenAI spans it cannot place', () => {
    const failed = { ...chat, spanId: 'f1', status: { code: 'STATUS_CODE_ERROR' }, attributes: [...chat.attributes, ...kv({ 'error.type': s('rate_limited') })] };
    const r = mapOtlpTraces(request([failed, { ...chat, spanId: undefined }, { ...chat, spanId: 'x', startTimeUnixNano: undefined }]), MAPPING);
    expect(r.events[0].event).toEqual(expect.objectContaining({ requestStatus: 'error', errorType: 'rate_limited' }));
    expect(r.rejected.map((x) => x.reason)).toEqual(['span has no traceId or spanId', 'span has no start time']);
  });

  it('keeps nanosecond timestamps exact and tolerates an empty export', () => {
    const late = { ...chat, startTimeUnixNano: '1790359832123456789', endTimeUnixNano: '1790359832623456789' };
    expect(mapOtlpTraces(request([late]), MAPPING).events[0].event).toEqual(expect.objectContaining({ timestamp: new Date(1790359832123).toISOString(), latencyMs: 500 }));
    expect(mapOtlpTraces({}, MAPPING)).toEqual({ events: [], skipped: 0, rejected: [] });
  });
});

describe('ingest keys (spec §18)', () => {
  it('generates keys that are found by prefix and checked against a stored hash only', () => {
    const a = generateIngestKey();
    const b = generateIngestKey();
    expect(a.key).toMatch(/^aftk_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(a.key).not.toBe(b.key);
    expect(prefixOf(a.key)).toBe(a.prefix);
    expect(a.hash).toBe(hashIngestKey(a.key));
    // The secret is base64url and may itself contain '_', so take it by position, not split('_').
    expect(a.hash).not.toContain(a.key.slice(`aftk_${a.prefix}_`.length));
    expect(matchesHash(a.key, a.hash)).toBe(true);
    expect(matchesHash(b.key, a.hash)).toBe(false);
  });

  it('refuses anything that is not a key before touching the database', () => {
    expect(prefixOf('Bearer something')).toBeNull();
    expect(prefixOf('aftk_short_x')).toBeNull();
  });

  it('reads the key from Authorization: Bearer or X-Ingest-Key', () => {
    expect(keyFromHeaders({ authorization: 'Bearer aftk_abc' })).toBe('aftk_abc');
    expect(keyFromHeaders({ 'x-ingest-key': ' aftk_abc ' })).toBe('aftk_abc');
    expect(keyFromHeaders({ authorization: 'Basic xyz' })).toBeNull();
    expect(keyFromHeaders({})).toBeNull();
  });
});

describe('INGEST_PATH - which routes get the larger body limit', () => {
  it.each(['/api/observability/usage-events', '/api/observability/v1/traces', '/api/projects/5bcb3de7-45f3-4ed6-b8be-31ea34eff490/token-observability/usage-events'])('includes %s', (p) => {
    expect(INGEST_PATH.test(p)).toBe(true);
  });

  it.each(['/api/projects/x/token-observability/prices', '/api/auth/login', '/api/observability/usage-events/extra', '/api/projects/x/discovery'])('excludes %s', (p) => {
    expect(INGEST_PATH.test(p)).toBe(false);
  });
});
