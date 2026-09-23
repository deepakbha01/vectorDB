import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { UserRole } from '../../users/user.entity';
import { AiFactoryEnabledGuard } from '../ai-factory-enabled.guard';
import { RagAgentDesignService } from './rag-agent.service';
import { CreateRagAgentDesignDto } from './create-rag-agent-design.dto';

/** GenAI Application Architecture - RAG / agent (spec §10). Hidden unless AI_FACTORY_ENABLED is on. */
@ApiTags('ai-factory')
@ApiBearerAuth()
@UseGuards(AiFactoryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/ai-factory/rag-agent')
export class RagAgentDesignController {
  constructor(private readonly service: RagAgentDesignService) {}

  /** Design context derived from the latest records, plus a preview design. Saves nothing. */
  @Get('defaults')
  defaults(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getDefaults(projectId, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRagAgentDesignDto) {
    return this.service.submit(projectId, user, dto);
  }

  @Get('latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await this.service.getLatest(projectId, user);
    if (!d) throw new NotFoundException('No RAG / agent design has been made for this project yet.');
    return d;
  }
}
