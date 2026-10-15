import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { LlmSummaryEnabledGuard } from './llm-summary-enabled.guard';
import { LlmConnectionsService } from './llm-connections.service';
import { CreateLlmConnectionDto, UpdateLlmConnectionDto } from './llm-connection.dto';
import { llmProviderCatalogue } from './llm-client.service';

/**
 * LLM integrations for the optional AI summaries. Admins add and change them;
 * admins and architects can list them to pick one. Keys are write-only.
 */
@ApiTags('llm-connections')
@ApiBearerAuth()
@UseGuards(LlmSummaryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('llm-connections')
export class LlmConnectionsController {
  constructor(private readonly service: LlmConnectionsService) {}

  @Get('providers')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  providers() {
    return llmProviderCatalogue();
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  list() {
    return this.service.list();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateLlmConnectionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateLlmConnectionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
  }

  /** A paid call of a few tokens to check the provider, model and key. */
  @Post(':id/test')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  test(@Param('id') id: string) {
    return this.service.test(id);
  }
}
