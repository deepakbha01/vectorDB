import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { UserRole } from '../../users/user.entity';
import { TokenObservabilityEnabledGuard } from './token-observability-enabled.guard';
import { TokenObservabilityService } from './token-observability.service';
import { PricingService } from './pricing.service';
import { CreateModelPriceDto } from './dto/create-model-price.dto';
import { UsageService } from './usage.service';
import { SimulationService, UploadedFileLike } from './simulation.service';
import { MAX_UPLOAD_BYTES } from './usage-upload';
import { SimulationUploadDto } from './dto/simulation-upload.dto';
import { IngestKeyService } from './ingest-key.service';
import { CreateIngestKeyDto } from './dto/create-ingest-key.dto';
import { AlertService } from './alert.service';
import { AlertsQueryDto } from './dto/alerts-query.dto';
import { UsageEventBatchDto } from './dto/usage-events.dto';
import { UsageQueryDto, UsageRequestsQueryDto } from './dto/usage-query.dto';

const TRACE_ID = /^[A-Za-z0-9_.:@/+=#-]{1,200}$/;

/** Token Observability, scoped to a project. Hidden unless AI_FACTORY_ENABLED and TOKEN_OBSERVABILITY_ENABLED are on. */
@ApiTags('token-observability')
@ApiBearerAuth()
@UseGuards(TokenObservabilityEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/token-observability')
export class TokenObservabilityController {
  constructor(
    private readonly service: TokenObservabilityService,
    private readonly pricing: PricingService,
    private readonly usage: UsageService,
    private readonly simulations: SimulationService,
    private readonly ingestKeys: IngestKeyService,
    private readonly alerts: AlertService,
  ) {}

  /** The Estimated-mode projection as the upstream records stand now. Saves nothing. */
  @Get('estimate/preview')
  preview(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.preview(projectId, user);
  }

  /** No body: the estimate is built entirely from the upstream phases and the price table. */
  @Post('estimate')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.submit(projectId, user);
  }

  @Get('estimate/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await this.service.getLatest(projectId, user);
    if (!d) throw new NotFoundException('No token estimate has been made for this project yet.');
    return d;
  }

  /** Catalogue prices and this project's contracted overrides, with their effective dates (spec §13). */
  @Get('prices')
  prices(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.pricing.list(projectId, user);
  }

  /** Adds a contracted price for this project; the previous one is closed, never edited. */
  @Post('prices')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  addPrice(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateModelPriceDto) {
    return this.pricing.addProjectPrice(projectId, user, dto);
  }

  // ------------------------------------------------------ observed usage (spec §15)

  /** A batch of normalized usage events (max 1000). Re-sent events are ignored; prompt or response text is rejected. */
  @Post('usage-events')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  ingest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() batch: UsageEventBatchDto) {
    return this.usage.ingest(projectId, user, batch);
  }

  @Get('summary')
  summary(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.summary(projectId, user, q);
  }

  @Get('tokens')
  tokens(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.tokens(projectId, user, q);
  }

  @Get('trends')
  trends(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.trends(projectId, user, q);
  }

  @Get('services')
  services(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.services(projectId, user, q);
  }

  @Get('models')
  models(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.models(projectId, user, q);
  }

  @Get('agents')
  agents(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.agents(projectId, user, q);
  }

  @Get('rag')
  rag(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.rag(projectId, user, q);
  }

  @Get('cost')
  cost(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.cost(projectId, user, q);
  }

  @Get('requests')
  requests(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageRequestsQueryDto) {
    return this.usage.requestList(projectId, user, q);
  }

  @Get('dimensions')
  dimensions(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: UsageQueryDto) {
    return this.usage.dimensions(projectId, user, q);
  }

  @Get('traces/:traceId')
  trace(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('traceId') traceId: string, @CurrentUser() user: AuthenticatedUser) {
    if (!TRACE_ID.test(traceId)) throw new BadRequestException('traceId must be an identifier.');
    return this.usage.trace(projectId, user, traceId);
  }

  // ------------------------------------------------ simulated mode (spec §12)

  /** Upload a load-test or benchmark result (multipart: `file` = JSON or CSV, optional `label`). Stored as simulated usage. */
  @Post('simulations')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  uploadSimulation(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: SimulationUploadDto) {
    return this.simulations.upload(projectId, user, file, body.label);
  }

  @Get('simulations')
  listSimulations(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.simulations.list(projectId, user);
  }

  /** One run, with the rows that were rejected and why. */
  @Get('simulations/:runId')
  getSimulation(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('runId', ParseUUIDPipe) runId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.simulations.get(projectId, user, runId);
  }

  /** Removes the run and its events; live usage and other runs are untouched. */
  @Delete('simulations/:runId')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  deleteSimulation(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('runId', ParseUUIDPipe) runId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.simulations.remove(projectId, user, runId);
  }

  // ------------------------------------------- live telemetry keys (spec §11, §18)

  /** Creates a project ingest key. The key is in this response only - it is stored as a hash. */
  @Post('ingest-keys')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  createIngestKey(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIngestKeyDto) {
    return this.ingestKeys.create(projectId, user, dto.name);
  }

  /** Key names, prefixes and use - never the keys. Admins and architects only. */
  @Get('ingest-keys')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  listIngestKeys(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ingestKeys.list(projectId, user);
  }

  @Delete('ingest-keys/:keyId')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  revokeIngestKey(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('keyId', ParseUUIDPipe) keyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ingestKeys.revoke(projectId, user, keyId);
  }

  // ------------------------------------------------------------ alerts (spec §14)

  /** Open alerts (or all with ?status=all), and what the last evaluation could not check. */
  @Get('alerts')
  listAlerts(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() q: AlertsQueryDto) {
    return this.alerts.list(projectId, user, q.status ?? 'open');
  }

  /** Runs the rules now instead of waiting for the schedule. */
  @Post('alerts/evaluate')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  evaluateAlerts(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.alerts.evaluate(projectId, user);
  }

  /** Records that someone is dealing with it; the alert still resolves itself when the rule stops firing. */
  @Post('alerts/:alertId/acknowledge')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  acknowledgeAlert(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('alertId', ParseUUIDPipe) alertId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.alerts.acknowledge(projectId, user, alertId);
  }
}
