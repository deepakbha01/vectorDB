import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { UserRole } from '../../users/user.entity';
import { AiFactoryEnabledGuard } from '../ai-factory-enabled.guard';
import { WorkloadProfileService } from './workload-profile.service';
import { CreateWorkloadProfileDto } from './create-workload-profile.dto';

/** AI Workload Profile (spec §4). Hidden unless AI_FACTORY_ENABLED is on. */
@ApiTags('ai-factory')
@ApiBearerAuth()
@UseGuards(AiFactoryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ai-factory/workload-profile')
export class WorkloadProfileController {
  constructor(private readonly service: WorkloadProfileService) {}

  /** Values the form is pre-filled with from Discovery / the project, plus a preview classification. Saves nothing. */
  @Get('defaults')
  defaults(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getDefaults(projectId, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWorkloadProfileDto) {
    return this.service.submit(projectId, user, dto);
  }

  @Get('latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const profile = await this.service.getLatest(projectId, user);
    if (!profile) throw new NotFoundException('No AI Workload Profile has been created for this project yet.');
    return profile;
  }

  @Get()
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getHistory(projectId, user);
  }
}
