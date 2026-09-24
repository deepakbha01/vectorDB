import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { VectorDbSelectionService } from './vector-db-selection.service';

@ApiTags('vector-db-selection')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/vector-db-selection')
export class VectorDbSelectionController {
  constructor(private readonly vectorDbSelectionService: VectorDbSelectionService) {}

  @Post('run')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  run(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.vectorDbSelectionService.run(projectId, user);
  }

  @Get('latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const outcome = await this.vectorDbSelectionService.getLatest(projectId, user);
    if (!outcome) {
      throw new NotFoundException('Vector DB Selection has not been run for this project yet.');
    }
    return outcome;
  }

  @Get('latest/sensitivity-analysis')
  sensitivityAnalysis(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.vectorDbSelectionService.runSensitivityAnalysis(projectId, user);
  }
}
