import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { AiFactoryService } from './ai-factory.service';
import { AiFactoryEnabledGuard } from './ai-factory-enabled.guard';

class SaveSnapshotDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

/** Discovery versions to compare; both optional (defaults: previous → latest). */
export class ImpactQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  from?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  to?: number;
}

/** Read-only AI Factory view over the existing phases. Every route is hidden unless AI_FACTORY_ENABLED is on. */
@ApiTags('ai-factory')
@ApiBearerAuth()
@UseGuards(AiFactoryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ai-factory')
export class AiFactoryController {
  constructor(private readonly service: AiFactoryService) {}

  /** Guided steps, phase lineage/staleness, and the central assessment state. */
  @Get()
  overview(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getOverview(projectId, user);
  }

  /** Standard, explainable decision records for every phase that has decided something. */
  @Get('decisions')
  decisions(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getDecisionRecords(projectId, user);
  }

  /** Which phases a Discovery change affects. Defaults: previous version → latest. */
  @Get('impact')
  impact(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Query() query: ImpactQueryDto) {
    return this.service.getImpact(projectId, user, query.from, query.to);
  }

  @Get('snapshots')
  snapshots(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listSnapshots(projectId, user);
  }

  @Get('snapshots/compare')
  compare(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('from', ParseIntPipe) from: number,
    @Query('to', ParseIntPipe) to: number,
  ) {
    return this.service.compareSnapshots(projectId, user, from, to);
  }

  @Post('snapshots')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  saveSnapshot(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: SaveSnapshotDto) {
    return this.service.saveSnapshot(projectId, user, dto.label);
  }
}
