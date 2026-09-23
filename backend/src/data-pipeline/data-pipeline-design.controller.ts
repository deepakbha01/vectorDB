import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { DataPipelineDesignService } from './data-pipeline-design.service';
import { CreateDataPipelineDesignDto } from './dto/create-data-pipeline-design.dto';

@ApiTags('data-pipeline')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/data-pipeline')
export class DataPipelineDesignController {
  constructor(private readonly designService: DataPipelineDesignService) {}

  @Post('designs')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDataPipelineDesignDto,
  ) {
    return this.designService.submitDesign(projectId, user, dto);
  }

  @Get('designs')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.designService.getHistory(projectId, user);
  }

  @Get('designs/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const design = await this.designService.getLatest(projectId, user);
    if (!design) {
      throw new NotFoundException('No Data Pipeline Design has been submitted for this project yet.');
    }
    return design;
  }

  @Get('handoff')
  handoff(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.designService.buildPhase3Handoff(projectId, user);
  }
}
