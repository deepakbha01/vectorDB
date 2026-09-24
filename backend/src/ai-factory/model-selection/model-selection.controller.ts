import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { UserRole } from '../../users/user.entity';
import { AiFactoryEnabledGuard } from '../ai-factory-enabled.guard';
import { ModelSelectionService } from './model-selection.service';
import { CreateModelSelectionDto } from './create-model-selection.dto';
import { AiFactoryConfigService } from '../ai-factory-config.service';

/** Model Selection (spec §7). Hidden unless AI_FACTORY_ENABLED is on. */
@ApiTags('ai-factory')
@ApiBearerAuth()
@UseGuards(AiFactoryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ai-factory/model-selection')
export class ModelSelectionController {
  constructor(
    private readonly service: ModelSelectionService,
    private readonly cfg: AiFactoryConfigService,
  ) {}

  /** The candidate catalogue (for display). */
  @Get('catalogue')
  catalogue() {
    const c = this.cfg.getModelCatalogue();
    return { rulesVersion: c.rulesVersion, models: c.models, licences: c.licences };
  }

  /** Requirements pre-filled from the Workload Profile, and a preview selection. Saves nothing. */
  @Get('defaults')
  defaults(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getDefaults(projectId, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateModelSelectionDto) {
    return this.service.submit(projectId, user, dto);
  }

  @Get('latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const selection = await this.service.getLatest(projectId, user);
    if (!selection) throw new NotFoundException('No model selection has been made for this project yet.');
    return selection;
  }

  @Get()
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getHistory(projectId, user);
  }
}
