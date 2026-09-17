import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { SelectPlatformDto } from './dto/select-platform.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { PlatformConfigService } from '../common/config/platform-config.service';

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  @Get('platform-catalog')
  getPlatformCatalog() {
    return this.platformConfig.getSupportedPlatforms();
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(user, dto.name, dto.businessUseCase, dto.industry);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.projectsService.findAllForUser(user.id);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projectsService.findOne(id, user);
  }

  @Patch(':id/platform')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  selectPlatform(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelectPlatformDto,
  ) {
    return this.projectsService.selectPlatform(id, user, dto.platform, dto.rationale);
  }
}
