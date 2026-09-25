import { Body, Controller, Headers, HttpCode, Logger, Post, Req, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ValidateNested } from 'class-validator';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { TokenObservabilityEnabledGuard } from './token-observability-enabled.guard';
import { IngestKeyGuard, IngestPrincipal } from './ingest-key.guard';
import { UsageService } from './usage.service';
import { UsageEventDto } from './dto/usage-events.dto';
import { mapOtlpTraces, OtlpTracesRequest } from './otlp';
import { toEventDto } from './usage-upload';

/** Live usage from one project's collector or SDK: the ingest key decides the project. */
export class KeyIngestBatchDto {
  @ValidateNested({ each: true })
  @Type(() => UsageEventDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  events: UsageEventDto[];
}

/** Requests per minute per client for machine ingest (the API-wide default is far lower). */
const INGEST_RATE = { default: { limit: () => Number(process.env.TOKEN_INGEST_RATE_LIMIT_PER_MIN ?? 600), ttl: 60_000 } };
const BATCH = 1000;

/**
 * Machine ingest of live telemetry (spec §11, §15). Authenticated by a
 * project ingest key, never a user login, and hidden unless Token
 * Observability is enabled. Everything written here is `live`.
 */
@ApiTags('token-observability')
@ApiHeader({ name: 'Authorization', description: 'Bearer aftk_... (a project ingest key)' })
@UseGuards(TokenObservabilityEnabledGuard, IngestKeyGuard)
@Throttle(INGEST_RATE)
@Controller('observability')
export class ObservabilityIngestController {
  private readonly logger = new Logger(ObservabilityIngestController.name);

  constructor(
    private readonly usage: UsageService,
    private readonly cfg: AiFactoryConfigService,
  ) {}

  /** Normalized usage events (spec §10), up to 1000 per request. Re-sent events are ignored. */
  @Post('usage-events')
  @HttpCode(200)
  async events(@Req() req: { ingestKey: IngestPrincipal }, @Body() batch: KeyIngestBatchDto) {
    const k = req.ingestKey;
    const res = await this.usage.ingestForProject(k.projectId, { telemetrySource: 'live', events: batch.events }, new Date());
    this.logger.log(`key=${k.prefix} action=ingest_usage projectId=${k.projectId} accepted=${res.accepted} duplicates=${res.duplicates} rejected=${res.rejected.length}`);
    return res;
  }

  /**
   * OTLP/HTTP traces in JSON encoding (an OpenTelemetry Collector `otlphttp`
   * exporter with `encoding: json`). GenAI spans become usage events; other
   * spans are skipped. Replies in the OTLP partial-success shape.
   */
  @Post('v1/traces')
  @HttpCode(200)
  async otlpTraces(@Req() req: { ingestKey: IngestPrincipal }, @Headers('content-type') contentType: string | undefined, @Body() body: OtlpTracesRequest) {
    if (!/^application\/json\b/i.test(contentType ?? '')) {
      throw new UnsupportedMediaTypeException('Send OTLP as JSON (collector otlphttp exporter: encoding: json). Protobuf is not accepted.');
    }
    const k = req.ingestKey;
    const mapped = mapOtlpTraces(body, this.cfg.getTokenObservabilityCatalogue().otel);
    const reasons: string[] = mapped.rejected.map((r) => `${r.ref}: ${r.reason}`);
    const events: UsageEventDto[] = [];
    for (const { ref, event } of mapped.events) {
      const checked = toEventDto(event);
      if ('reason' in checked) reasons.push(`${ref}: ${checked.reason}`);
      else events.push(checked.dto);
    }
    let accepted = 0;
    let duplicates = 0;
    for (let i = 0; i < events.length; i += BATCH) {
      const res = await this.usage.ingestForProject(k.projectId, { telemetrySource: 'live', events: events.slice(i, i + BATCH) }, new Date());
      accepted += res.accepted;
      duplicates += res.duplicates;
      reasons.push(...res.rejected.map((r) => `${r.eventId}: ${r.reason}`));
    }
    this.logger.log(`key=${k.prefix} action=ingest_otlp projectId=${k.projectId} genAiSpans=${mapped.events.length + mapped.rejected.length} skipped=${mapped.skipped} accepted=${accepted} duplicates=${duplicates} rejected=${reasons.length}`);
    // OTLP partial success: rejected spans are counted; duplicates are not errors (the exporter may retry).
    return reasons.length ? { partialSuccess: { rejectedSpans: reasons.length, errorMessage: reasons.slice(0, 5).join(' | ') } } : {};
  }
}
