import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { DataExplorerEnabledGuard } from './data-explorer-enabled.guard';
import { DataExplorerReadAuditInterceptor } from './data-explorer-read-audit.interceptor';
import { DataExplorerService } from './data-explorer.service';
import { ExplorerDocumentsQueryDto, ExplorerSearchDto } from './dto/explorer-search.dto';

/**
 * Data Explorer - read-only view into the project's target vector database.
 * Status, collections and the design comparison are open to any member; the
 * record contents (documents, search) to admins and architects only.
 */
@ApiTags('data-explorer')
@ApiBearerAuth()
@UseGuards(DataExplorerEnabledGuard, JwtAuthGuard, RolesGuard)
@UseInterceptors(DataExplorerReadAuditInterceptor)
@Controller('projects/:projectId/data-explorer')
export class DataExplorerController {
  constructor(private readonly service: DataExplorerService) {}

  @Get('status')
  status(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.status(projectId, user);
  }

  @Get('collections')
  collections(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.collections(projectId, user);
  }

  @Get('collections/:name')
  overview(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('name') name: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.overview(projectId, user, name);
  }

  @Get('collections/:name/documents')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  documents(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('name') name: string, @Query() q: ExplorerDocumentsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.documents(projectId, user, name, q);
  }

  /** POST only because the query can be a long text or vector; it changes nothing. */
  @Post('collections/:name/search')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  search(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('name') name: string, @Body() dto: ExplorerSearchDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.search(projectId, user, name, dto);
  }
}
