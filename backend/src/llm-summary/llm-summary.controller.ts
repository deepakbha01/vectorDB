import { BadRequestException, Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { LlmSummaryEnabledGuard } from './llm-summary-enabled.guard';
import { LlmSummaryService } from './llm-summary.service';
import { CreateLlmSummaryDto } from './create-llm-summary.dto';
import { LLM_SUMMARY_SUBJECTS, LlmSummarySubject } from './llm-summary.prompt';

/**
 * Optional AI-written narrative of a stored assessment. Runs only when someone
 * asks for it; hidden unless LLM_SUMMARY_ENABLED is on and an LLM is configured.
 */
@ApiTags('llm-summary')
@ApiBearerAuth()
@UseGuards(LlmSummaryEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/llm-summary')
export class LlmSummaryController {
  constructor(private readonly service: LlmSummaryService) {}

  /** Each call is a paid LLM request, so it is limited to the roles that can run assessments. */
  @Post(':subject')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('subject') subject: string,
    @Body() dto: CreateLlmSummaryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!(LLM_SUMMARY_SUBJECTS as readonly string[]).includes(subject)) {
      throw new BadRequestException(`Unknown summary subject '${subject}'. Supported: ${LLM_SUMMARY_SUBJECTS.join(', ')}.`);
    }
    return this.service.summarize(projectId, subject as LlmSummarySubject, dto.audience ?? 'executive', user);
  }
}
