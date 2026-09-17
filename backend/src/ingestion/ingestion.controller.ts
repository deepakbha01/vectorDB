import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { IngestionService } from './ingestion.service';
import { CreateIngestionRunDto } from './dto/create-ingestion-run.dto';

@ApiTags('ingestion')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ingestion')
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('runs')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  run(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateIngestionRunDto,
  ) {
    return this.ingestionService.runIngestion(projectId, user, dto);
  }

  @Get('runs')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ingestionService.getHistory(projectId, user);
  }

  @Get('runs/:runId')
  getRun(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ingestionService.getRun(projectId, user, runId);
  }

  @Get('runs/:runId/dead-letters')
  getDeadLetters(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ingestionService.getDeadLetters(projectId, user, runId);
  }

  @Post('runs/:runId/retry-dead-letters')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  retryDeadLetters(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ingestionService.retryDeadLetters(projectId, user, runId);
  }
}
