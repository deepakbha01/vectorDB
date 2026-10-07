import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService } from './azure-builder.service';
import { CreateAzureConnectionDto, CreateEnvironmentProfileDto } from './dto/azure-builder.dto';

/**
 * Azure AI Factory Builder, scoped to a project. Reads are open to project
 * members; changes to admins and architects. Hidden unless AZURE_BUILDER_ENABLED.
 */
@ApiTags('azure-builder')
@ApiBearerAuth()
@UseGuards(AzureBuilderEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/azure-builder')
export class AzureBuilderController {
  constructor(private readonly service: AzureBuilderService) {}

  /** Current connection (with permission level), latest Environment Profile and whether it is stale. */
  @Get()
  state(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getState(projectId, user);
  }

  // ---- Phase 0 - Connect ----

  @Post('connections')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  connect(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAzureConnectionDto) {
    return this.service.connect(projectId, user, dto);
  }

  @Post('connections/disconnect')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  disconnect(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.disconnect(projectId, user);
  }

  @Get('connections')
  connections(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.connectionHistory(projectId, user);
  }

  // ---- Phase 1 - Discover ----

  @Post('environment-profiles')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  discover(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEnvironmentProfileDto) {
    return this.service.discover(projectId, user, dto);
  }

  @Get('environment-profiles')
  profiles(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.profileHistory(projectId, user);
  }

  /** The Resource Graph queries to run in the Azure portal (offline mode). */
  @Get('discovery-queries')
  queries() {
    return this.service.discoveryQueries();
  }
}
