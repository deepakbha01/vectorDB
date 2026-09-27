import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { ConnectionProfilesService } from './connection-profiles.service';
import { ConnectionSettingsDto, ConnectionTestDto } from './dto/connection-settings.dto';

/**
 * A project's own connection to its target database, used by ingestion,
 * deployment, benchmarks and the Data Explorer in place of the server's
 * TARGET_* settings. Any member can see which settings are set (never secret
 * values); admins and architects change and test it.
 */
@ApiTags('connection')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/connection')
export class ConnectionProfilesController {
  constructor(private readonly service: ConnectionProfilesService) {}

  @Get()
  get(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(projectId, user);
  }

  @Put()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  save(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: ConnectionSettingsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.save(projectId, user, dto.settings);
  }

  @Delete()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  remove(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.remove(projectId, user);
  }

  @Post('test')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  test(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: ConnectionTestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.test(projectId, user, dto.settings);
  }
}
