import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { FeaturesController } from '../../features/features.controller';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AlertService } from './alert.service';

const LOCK = 'token-alerts';

/**
 * Evaluates token alerts on a timer (spec §14). No scheduler dependency: a
 * plain interval, never overlapping itself, and a Postgres advisory lock so
 * that with several app instances only one evaluates at a time.
 * Off when Token Observability is off or TOKEN_ALERTS_ENABLED=false.
 */
@Injectable()
export class AlertSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AlertSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly cfg: AiFactoryConfigService,
    private readonly alerts: AlertService,
    private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap() {
    const enabled = new FeaturesController(this.config).flags().tokenObservability && String(this.config.get('TOKEN_ALERTS_ENABLED') ?? 'true').toLowerCase() !== 'false';
    if (!enabled) return;
    const minutes = Math.max(1, this.cfg.getTokenObservabilityCatalogue().alerts.evaluateEveryMinutes);
    this.timer = setInterval(() => void this.runOnce(), minutes * 60_000);
    this.timer.unref();
    this.logger.log(`Token alerts evaluated every ${minutes} min`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every active project. Returns how many were evaluated (0 if another instance holds the lock). */
  async runOnce(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      const [{ locked }] = await qr.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [LOCK]);
      if (!locked) return 0;
      try {
        let n = 0;
        for (const projectId of await this.alerts.activeProjects(now)) {
          try {
            await this.alerts.evaluateProject(projectId, now);
            n++;
          } catch (e) {
            // One project's failure must not stop the others.
            this.logger.warn(`Alert evaluation failed for project ${projectId}: ${(e as Error).message}`);
          }
        }
        return n;
      } finally {
        await qr.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK]);
      }
    } catch (e) {
      this.logger.warn(`Alert evaluation skipped: ${(e as Error).message}`);
      return 0;
    } finally {
      await qr.release();
      this.running = false;
    }
  }
}
