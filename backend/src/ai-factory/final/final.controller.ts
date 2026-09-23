import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { UserRole } from '../../users/user.entity';
import { AiFactoryEnabledGuard } from '../ai-factory-enabled.guard';
import { FinalRecommendationService } from './final.service';

/** Final AI Architecture Recommendation and production-readiness gate. Hidden unless AI_FACTORY_ENABLED is on. */
@ApiTags('ai-factory')
@ApiBearerAuth()
@UseGuards(AiFactoryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ai-factory/final')
export class FinalRecommendationController {
  constructor(private readonly service: FinalRecommendationService) {}

  /** The recommendation as the records stand now. Saves nothing. */
  @Get('preview')
  preview(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.preview(projectId, user);
  }

  /** No body: the recommendation is built entirely from the other phases. */
  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.submit(projectId, user);
  }

  @Get('latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await this.service.getLatest(projectId, user);
    if (!d) throw new NotFoundException('No final recommendation has been made for this project yet.');
    return d;
  }
}
