import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { UserRole } from '../../users/user.entity';
import { AiFactoryEnabledGuard } from '../ai-factory-enabled.guard';
import { OperationsModelService } from './operations.service';
import { CreateOperationsModelDto } from './create-operations-model.dto';

/** AI Operations Model (spec §14). Hidden unless AI_FACTORY_ENABLED is on. */
@ApiTags('ai-factory')
@ApiBearerAuth()
@UseGuards(AiFactoryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ai-factory/operations')
export class OperationsModelController {
  constructor(private readonly service: OperationsModelService) {}

  /** Assessment context derived from the latest records, plus a preview assessment. Saves nothing. */
  @Get('defaults')
  defaults(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getDefaults(projectId, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOperationsModelDto) {
    return this.service.submit(projectId, user, dto);
  }

  @Get('latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await this.service.getLatest(projectId, user);
    if (!d) throw new NotFoundException('No operations model has been made for this project yet.');
    return d;
  }
}
