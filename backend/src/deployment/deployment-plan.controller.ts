import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { DeploymentPlanService } from './deployment-plan.service';

@ApiTags('deployment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/deployment')
export class DeploymentPlanController {
  constructor(private readonly deploymentPlanService: DeploymentPlanService) {}

  @Post('plans')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deploymentPlanService.submitPlan(projectId, user);
  }

  @Get('plans')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deploymentPlanService.getHistory(projectId, user);
  }

  @Get('plans/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const plan = await this.deploymentPlanService.getLatest(projectId, user);
    if (!plan) {
      throw new NotFoundException('No Deployment Plan has been submitted for this project yet.');
    }
    return plan;
  }

  /**
   * Explicit, separate action: actually connects to the configured target
   * database and creates the schema + vector index. Never triggered by
   * `submit`/`GET` above.
   */
  @Post('execute')
  @Roles(UserRole.ADMIN)
  execute(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deploymentPlanService.executeLatestPlan(projectId, user);
  }
}
