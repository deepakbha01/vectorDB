import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { InferenceService } from './inference.service';
import { CreateInferenceAssessmentDto } from './dto/create-inference-assessment.dto';
import { ProjectsService } from '../projects/projects.service';
import { PdfRendererService } from '../reporting/pdf-renderer.service';
import { DocxRendererService } from '../reporting/docx-renderer.service';
import { buildInferenceReport } from './inference-report.builder';

@ApiTags('inference')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/inference')
export class InferenceController {
  constructor(
    private readonly inferenceService: InferenceService,
    private readonly projectsService: ProjectsService,
    private readonly pdf: PdfRendererService,
    private readonly docx: DocxRendererService,
  ) {}

  /** Models, GPUs, precisions and API tiers for the intake form. */
  @Get('catalogue')
  async catalogue(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.inferenceService.getCatalogue();
  }

  /** Read-only suggestions from this project's vector-DB Discovery / Data Pipeline, if completed. */
  @Get('defaults')
  defaults(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inferenceService.getDefaults(projectId, user);
  }

  @Post('assessments')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submit(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInferenceAssessmentDto,
  ) {
    return this.inferenceService.submit(projectId, user, dto);
  }

  @Get('assessments')
  history(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inferenceService.getHistory(projectId, user);
  }

  @Get('assessments/latest')
  async latest(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const assessment = await this.inferenceService.getLatest(projectId, user);
    if (!assessment) throw new NotFoundException('No Inference assessment has been submitted for this project yet.');
    return assessment;
  }

  /** PDF/DOCX export via the platform's shared renderers. */
  @Get('report')
  async report(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('format') format: string = 'pdf',
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    if (format !== 'pdf' && format !== 'docx') throw new BadRequestException(`Unknown report format '${format}'. Supported: pdf, docx.`);
    const project = await this.projectsService.findOne(projectId, user);
    const assessment = await this.inferenceService.getLatest(projectId, user);
    if (!assessment) throw new NotFoundException('No Inference assessment has been submitted for this project yet.');

    const doc = buildInferenceReport(project.name, assessment);
    const buffer = format === 'pdf' ? await this.pdf.render(doc) : await this.docx.render(doc);
    const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    res.set({
      'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${safeName}-inference-assessment-v${assessment.version}.${format}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
