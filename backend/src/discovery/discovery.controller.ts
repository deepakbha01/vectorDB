import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { DiscoveryService } from './discovery.service';
import { CreateDiscoveryAssessmentDto } from './dto/create-discovery-assessment.dto';

@ApiTags('discovery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/discovery')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Post('assessments')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDiscoveryAssessmentDto,
  ) {
    return this.discoveryService.submitAssessment(projectId, user, dto);
  }

  @Get('assessments')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.discoveryService.getHistory(projectId, user);
  }

  @Get('assessments/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const outcome = await this.discoveryService.getLatest(projectId, user);
    if (!outcome) {
      throw new NotFoundException('No Discovery assessment has been submitted for this project yet.');
    }
    return outcome;
  }

}
