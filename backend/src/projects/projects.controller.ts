import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { SelectPlatformDto } from './dto/select-platform.dto';
import { UpdateUseCaseDto } from './dto/update-use-case.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { SuggestablePattern, suggestUseCase, UseCaseSuggestion } from './use-case-suggestion';

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

  @Get('pattern-catalog')
  getPatternCatalog() {
    return this.platformConfig.getPatternCatalog();
  }

  /** Recommends New Project inputs (business use case, industry, pattern) from the application name; every value stays editable. */
  @Get('use-case-suggestion')
  suggestUseCase(@Query('name') name?: string): UseCaseSuggestion {
    if (!name?.trim()) throw new BadRequestException('name is required.');
    if (name.length > 200) throw new BadRequestException('name must be 200 characters or fewer.');
    return suggestUseCase(name, this.platformConfig.getPatternCatalog() as SuggestablePattern[]);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(user, dto.name, dto.businessUseCase, dto.industry, dto.patternId, dto.customerMode);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.projectsService.findAllForUser(user.id);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projectsService.findOne(id, user);
  }

  /** Edits the business use case after creation - the project owner or an admin. */
  @Patch(':id/use-case')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  updateUseCase(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateUseCaseDto,
  ) {
    return this.projectsService.updateUseCase(id, user, dto.businessUseCase, dto.industry);
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

  /**
   * Permanently deletes the project and everything recorded for it (every
   * phase, AI Factory and Token Observability record). The audit log keeps
   * its entries. Owners (admin / architect) and admins only.
   */
  @Delete(':id')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projectsService.remove(id, user);
  }
}
