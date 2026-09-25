import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
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

/** Token Observability, scoped to a project. Hidden unless AI_FACTORY_ENABLED and TOKEN_OBSERVABILITY_ENABLED are on. */
@ApiTags('token-observability')
@ApiBearerAuth()
@UseGuards(TokenObservabilityEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/token-observability')
export class TokenObservabilityController {
  constructor(
    private readonly service: TokenObservabilityService,
    private readonly pricing: PricingService,
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
}
