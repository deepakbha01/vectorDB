import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { CapacityPlanningService } from './capacity-planning.service';
import { CreateCapacityPlanDto } from './dto/create-capacity-plan.dto';

@ApiTags('capacity-planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/capacity-planning')
export class CapacityPlanningController {
  constructor(private readonly capacityPlanningService: CapacityPlanningService) {}

  @Post('plans')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  generate(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCapacityPlanDto,
  ) {
    return this.capacityPlanningService.generatePlan(projectId, user, dto);
  }

  @Get('plans')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.capacityPlanningService.getHistory(projectId, user);
  }

  @Get('plans/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const plan = await this.capacityPlanningService.getLatest(projectId, user);
    if (!plan) {
      throw new NotFoundException('No Capacity Plan has been generated for this project yet.');
    }
    return plan;
  }
}
