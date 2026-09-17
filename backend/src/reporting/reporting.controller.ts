import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { REPORT_FORMATS, REPORT_TYPES, ReportFormat, ReportingService, ReportType } from './reporting.service';

@ApiTags('reporting')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/reports')
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get(':type')
  async download(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('type') type: string,
    @Query('format') format: string = 'pdf',
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    if (!REPORT_TYPES.includes(type as ReportType)) {
      throw new BadRequestException(`Unknown report type '${type}'. Supported: ${REPORT_TYPES.join(', ')}.`);
    }
    if (!REPORT_FORMATS.includes(format as ReportFormat)) {
      throw new BadRequestException(`Unknown report format '${format}'. Supported: ${REPORT_FORMATS.join(', ')}.`);
    }

    const { buffer, filename, contentType } = await this.reportingService.generateReport(
      projectId,
      user,
      type as ReportType,
      format as ReportFormat,
    );

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
