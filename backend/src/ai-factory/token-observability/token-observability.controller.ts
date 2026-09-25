import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
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
}
