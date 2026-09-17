import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { IndexDesignService } from './index-design.service';
import { CreateIndexDesignDto } from './dto/create-index-design.dto';

@ApiTags('index-design')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/index-design')
export class IndexDesignController {
  constructor(private readonly indexDesignService: IndexDesignService) {}

  @Post('designs')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateIndexDesignDto,
  ) {
    return this.indexDesignService.submitDesign(projectId, user, dto);
  }

  @Get('designs')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.indexDesignService.getHistory(projectId, user);
  }

  @Get('designs/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const design = await this.indexDesignService.getLatest(projectId, user);
    if (!design) {
      throw new NotFoundException('No Index Design has been submitted for this project yet.');
    }
    return design;
  }
}
