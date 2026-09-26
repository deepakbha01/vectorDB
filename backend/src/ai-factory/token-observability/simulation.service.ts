import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { AiSimulationRun, UploadRejection } from './simulation-run.entity';
import { AiUsageEvent } from './usage-event.entity';
import { lockRollups, UsageService } from './usage.service';
import { MAX_UPLOAD_BYTES, parseUpload } from './usage-upload';
import { ROLLUP_DIMENSIONS } from './usage-ingest';

/** The fields of an uploaded file this service reads (multer's memory-storage file). */
export interface UploadedFileLike {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const BATCH = 1000;
const KEEP_REJECTIONS = 200;
const HOUR = `date_trunc('hour', e."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/**
 * Simulated mode (spec §12): load-test and benchmark results uploaded as
 * files, stored as simulated usage and kept apart from live usage. Each
 * upload is a run that can be listed and removed as a whole.
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly usage: UsageService,
    @InjectRepository(AiSimulationRun) private readonly runs: Repository<AiSimulationRun>,
    @InjectRepository(AiUsageEvent) private readonly events: Repository<AiUsageEvent>,
  ) {}

  async upload(projectId: string, requester: AuthenticatedUser, file: UploadedFileLike | undefined, label: string | undefined, now = new Date()) {
    await this.projectsService.findOne(projectId, requester);
    if (!file) throw new BadRequestException('Attach a JSON or CSV file in the "file" field.');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    const parsed = parseUpload(file.buffer.toString('utf8'), file.originalname, projectId);
    if ('error' in parsed) throw new BadRequestException(parsed.error);

    const run = await this.runs.save(
      this.runs.create({
        project: { id: projectId } as Project,
        createdBy: { id: requester.id } as User,
        label: (label?.trim() || file.originalname).slice(0, 200),
        fileName: file.originalname.slice(0, 255),
        format: parsed.format,
        received: parsed.received,
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        unpriced: 0,
        firstEventAt: null,
        lastEventAt: null,
        rejections: [],
        status: 'in_progress',
        error: null,
      }),
    );
    // Row numbers for rejections found after parsing (future timestamps, an eventId repeated in the file).
    const rowOf = new Map<string, number>();
    parsed.events.forEach((e, i) => rowOf.set(e.eventId, parsed.eventRows[i]));
    const rejections: UploadRejection[] = [...parsed.rejections];
    let accepted = 0;
    let duplicates = 0;
    let unpriced = 0;
    const finish = async (status: 'complete' | 'failed', error: string | null) => {
      const [span] = await this.events.manager.query(`SELECT MIN("timestamp") AS first, MAX("timestamp") AS last FROM "ai_usage_events" WHERE "simulationRunId" = $1`, [run.id]);
      rejections.sort((a, b) => a.row - b.row);
      Object.assign(run, {
        accepted,
        duplicates,
        unpriced,
        rejected: rejections.length,
        firstEventAt: span.first ? new Date(span.first) : null,
        lastEventAt: span.last ? new Date(span.last) : null,
        rejections: rejections.slice(0, KEEP_REJECTIONS),
        status,
        error,
      });
      return this.runs.save(run);
    };
    try {
      for (let i = 0; i < parsed.events.length; i += BATCH) {
        const res = await this.usage.ingestForProject(projectId, { telemetrySource: 'simulated', events: parsed.events.slice(i, i + BATCH) }, now, run.id);
        accepted += res.accepted;
        duplicates += res.duplicates;
        unpriced += res.unpriced;
        rejections.push(...res.rejected.map((x) => ({ row: rowOf.get(x.eventId) ?? 0, eventId: x.eventId, reason: x.reason })));
        // Progress is kept per batch, so the run always says what was stored.
        await this.runs.update({ id: run.id }, { accepted, duplicates, unpriced });
      }
    } catch (e) {
      // Batches already stored stay with this run; the run says it failed and how far it got. Delete it to remove them.
      const message = (e as Error).message;
      await finish('failed', `Stopped after ${accepted.toLocaleString()} of ${parsed.events.length.toLocaleString()} events: ${message}`).catch(() => undefined);
      this.logger.warn(`action=upload_simulation_failed projectId=${projectId} run=${run.id} accepted=${accepted} error=${message}`);
      throw new InternalServerErrorException(`The upload stopped after ${accepted.toLocaleString()} of ${parsed.events.length.toLocaleString()} events and run "${run.label}" is marked failed. Delete that run and upload the file again.`);
    }
    const saved = await finish('complete', null);
    this.logger.log(`user=${requester.email} action=upload_simulation projectId=${projectId} run=${run.id} received=${parsed.received} accepted=${accepted} duplicates=${duplicates} rejected=${rejections.length}`);
    return { ...this.view(saved), ignoredFields: parsed.ignoredFields, rejectionsTruncated: rejections.length > KEEP_REJECTIONS };
  }

  async list(projectId: string, requester: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, requester);
    const rows = await this.runs.find({ where: { project: { id: projectId } }, relations: { createdBy: true }, order: { createdAt: 'DESC' }, take: 100 });
    return rows.map((r) => ({ ...this.view(r), rejections: undefined, uploadedBy: r.createdBy?.email ?? null }));
  }

  async get(projectId: string, requester: AuthenticatedUser, runId: string) {
    await this.projectsService.findOne(projectId, requester);
    const run = await this.runs.findOne({ where: { id: runId, project: { id: projectId } } });
    if (!run) throw new NotFoundException('No such simulation run in this project.');
    return this.view(run);
  }

  /**
   * Removes a run and its events, then rebuilds the simulated hourly totals
   * for the hours it touched from the events that remain. Live usage and
   * other runs are untouched.
   */
  async remove(projectId: string, requester: AuthenticatedUser, runId: string) {
    await this.projectsService.findOne(projectId, requester);
    const run = await this.runs.findOne({ where: { id: runId, project: { id: projectId } } });
    if (!run) throw new NotFoundException('No such simulation run in this project.');
    const removed = await this.events.manager.transaction(async (m) => {
      await lockRollups(m, projectId);
      const hours: Array<{ h: Date }> = await m.query(`SELECT DISTINCT ${HOUR} AS h FROM "ai_usage_events" e WHERE e."simulationRunId" = $1`, [runId]);
      const del = await m.query(`DELETE FROM "ai_usage_events" WHERE "simulationRunId" = $1`, [runId]);
      if (hours.length) {
        const buckets = hours.map((x) => x.h);
        await m.query(`DELETE FROM "ai_usage_rollups" WHERE "projectId" = $1 AND "telemetrySource" = 'simulated' AND "bucketStart" = ANY($2)`, [projectId, buckets]);
        const dims = ROLLUP_DIMENSIONS.map((d) => `COALESCE(e."${d}", '')`);
        await m.query(
          `INSERT INTO "ai_usage_rollups" ("projectId", "bucketStart", "telemetrySource", ${ROLLUP_DIMENSIONS.map((d) => `"${d}"`).join(', ')},
             "events", "errors", "inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "totalTokens", "embeddingTokens", "rerankingTokens", "contextTokens", "llmCalls", "toolCalls", "latencyMsSum", "costTotal")
           SELECT e."projectId", ${HOUR}, e."telemetrySource", ${dims.join(', ')},
                  COUNT(*), COUNT(*) FILTER (WHERE e."requestStatus" = 'error'), SUM(e."inputTokens"), SUM(e."outputTokens"), SUM(COALESCE(e."reasoningTokens", 0)), SUM(COALESCE(e."cachedInputTokens", 0)),
                  SUM(e."totalTokens"), SUM(e."embeddingTokens"), SUM(e."rerankingTokens"), SUM(e."contextTokens"), SUM(e."llmCallCount"), SUM(e."toolCallCount"), SUM(COALESCE(e."latencyMs", 0)), SUM(COALESCE(e."estimatedTotalCost", 0))
             FROM "ai_usage_events" e
            WHERE e."projectId" = $1 AND e."telemetrySource" = 'simulated' AND ${HOUR} = ANY($2)
            GROUP BY e."projectId", 2, e."telemetrySource", ${dims.map((_, i) => i + 4).join(', ')}`,
          [projectId, buckets],
        );
      }
      await m.delete(AiSimulationRun, { id: runId });
      // pg returns [rows, count] for DELETE through query().
      return Array.isArray(del) ? Number(del[1]) : 0;
    });
    this.logger.log(`user=${requester.email} action=delete_simulation projectId=${projectId} run=${runId} events=${removed}`);
    return { id: runId, eventsRemoved: removed };
  }

  private view(r: AiSimulationRun) {
    return {
      id: r.id,
      label: r.label,
      fileName: r.fileName,
      format: r.format,
      received: r.received,
      accepted: r.accepted,
      duplicates: r.duplicates,
      rejected: r.rejected,
      unpriced: r.unpriced,
      firstEventAt: r.firstEventAt,
      lastEventAt: r.lastEventAt,
      rejections: r.rejections,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
    };
  }
}
