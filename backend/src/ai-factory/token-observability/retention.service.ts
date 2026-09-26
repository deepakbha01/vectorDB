import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { FeaturesController } from '../../features/features.controller';

const DAY = 86_400_000;
const LOCK = 'token-retention';
const BATCH = 5000;

export interface RetentionPolicy {
  /** Raw usage events (request-level detail, traces). */
  eventDays: number;
  /** Hourly totals - kept longer so trends outlive request-level detail. */
  rollupDays: number;
  /** Resolved alerts. Open alerts are never removed. */
  resolvedAlertDays: number;
}

const positive = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

export function retentionPolicy(get: (key: string) => unknown): RetentionPolicy {
  const eventDays = positive(get('TOKEN_USAGE_RETENTION_DAYS'), 395);
  return {
    eventDays,
    // Totals can never be kept for less time than the events they summarise.
    rollupDays: Math.max(eventDays, positive(get('TOKEN_ROLLUP_RETENTION_DAYS'), 1095)),
    resolvedAlertDays: positive(get('TOKEN_ALERT_RETENTION_DAYS'), 180),
  };
}

/**
 * Retention clean-up for Token Observability (spec §18). Runs daily, deletes
 * in batches so no long lock is held, and uses an advisory lock so only one
 * instance cleans at a time. Off with TOKEN_RETENTION_ENABLED=false.
 */
@Injectable()
export class TokenRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TokenRetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap() {
    const enabled = new FeaturesController(this.config).flags().tokenObservability && String(this.config.get('TOKEN_RETENTION_ENABLED') ?? 'true').toLowerCase() !== 'false';
    if (!enabled) return;
    this.timer = setInterval(() => void this.runOnce(), DAY);
    this.timer.unref();
    const p = retentionPolicy((k) => this.config.get(k));
    this.logger.log(`Token usage retention: events ${p.eventDays} d, hourly totals ${p.rollupDays} d, resolved alerts ${p.resolvedAlertDays} d (daily)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One clean-up pass. Returns what was removed, or null if another instance holds the lock. */
  async runOnce(now = new Date()): Promise<{ events: number; rollups: number; alerts: number; runs: number } | null> {
    if (this.running) return null;
    this.running = true;
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      const [{ locked }] = await qr.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [LOCK]);
      if (!locked) return null;
      try {
        const p = retentionPolicy((k) => this.config.get(k));
        const cutoff = (days: number) => new Date(now.getTime() - days * DAY);
        const batched = async (table: string, where: string, param: Date) => {
          let total = 0;
          for (;;) {
            const res = await qr.query(`DELETE FROM "${table}" WHERE id IN (SELECT id FROM "${table}" WHERE ${where} LIMIT ${BATCH})`, [param]);
            const n = Array.isArray(res) ? Number(res[1]) : 0;
            total += n;
            if (n < BATCH) return total;
          }
        };
        const events = await batched('ai_usage_events', `"timestamp" < $1`, cutoff(p.eventDays));
        const rollups = await batched('ai_usage_rollups', `"bucketStart" < $1`, cutoff(p.rollupDays));
        const alerts = await batched('ai_token_alerts', `status = 'resolved' AND "resolvedAt" < $1`, cutoff(p.resolvedAlertDays));
        // A simulation run whose events have all expired has nothing left to show.
        const runs = await batched('ai_simulation_runs', `"lastEventAt" < $1 AND NOT EXISTS (SELECT 1 FROM "ai_usage_events" e WHERE e."simulationRunId" = "ai_simulation_runs".id)`, cutoff(p.eventDays));
        if (events || rollups || alerts || runs) this.logger.log(`action=token_retention events=${events} rollups=${rollups} alerts=${alerts} runs=${runs}`);
        return { events, rollups, alerts, runs };
      } finally {
        await qr.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK]);
      }
    } catch (e) {
      this.logger.warn(`Token retention skipped: ${(e as Error).message}`);
      return null;
    } finally {
      await qr.release();
      this.running = false;
    }
  }
}
